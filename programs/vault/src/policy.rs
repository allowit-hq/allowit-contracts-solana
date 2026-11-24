use crate::{Figures, Operations, Param, VaultError, VaultState};
use allowit_core::{
    check_params, post_flight, preflight, Address, AllowitArgs, AllowitContext, AllowitEnv,
    AllowitError, AllowitMap, AllowitOperation, AllowitParams, AllowitRequest,
    AllowitStandardState, AllowitTier, AllowitValue, RULES,
};
use solana_program_error::ProgramError;
use solana_pubkey::Pubkey;

pub(crate) fn params(rules: &[u8], values: &[Param]) -> Result<AllowitMap, ProgramError> {
    if values.len() > rules.len() || rules.len() > RULES.len() {
        return Err(VaultError::InvalidParam.into());
    }
    let mut params = AllowitMap::new();
    let mut values = values.iter();
    for &index in rules {
        let rule = RULES
            .get(usize::from(index))
            .ok_or(VaultError::InvalidParam)?;
        let value = values
            .next()
            .ok_or_else(|| core_error(AllowitError::MissingParam))?;
        let value = match (index, value) {
            (0..=3, Param::Amount(value)) => AllowitValue::Int(*value),
            (4, Param::Count(value)) => AllowitValue::Int(i128::from(*value)),
            (5 | 6, Param::Addresses(keys)) => AllowitValue::List(
                keys.iter()
                    .map(|key| AllowitValue::Addr(address(&Pubkey::new_from_array(*key))))
                    .collect(),
            ),
            (7, Param::Expiry(value)) => AllowitValue::Int(i128::from(*value)),
            (8, Param::Operations(Operations::Any)) => AllowitValue::Str("*".into()),
            (8, Param::Operations(Operations::Names(names))) => AllowitValue::List(
                names
                    .iter()
                    .map(|name| AllowitValue::Str(name.as_str().into()))
                    .collect(),
            ),
            _ => return Err(core_error(AllowitError::InvalidParam)),
        };
        if params.insert(rule.key().into(), value).is_some() {
            return Err(VaultError::InvalidParam.into());
        }
    }
    check_params(&params, AllowitTier::Standard).map_err(core_error)?;
    Ok(params)
}

pub(crate) fn evaluate(
    state: &VaultState,
    recipient: &Pubkey,
    amount: u64,
    now: u64,
    expires_at: u64,
) -> Result<Figures, ProgramError> {
    let mut policy_state = AllowitMap::new();
    let figures = &state.figures;
    AllowitStandardState {
        calls: figures.calls,
        spent: figures.spent,
        day: figures.day,
        day_spent: figures.day_spent,
        day_total: figures.day_total,
        unpriced: false,
        day_unpriced: false,
    }
    .write(&mut policy_state)
    .map_err(core_error)?;
    let mint = address(&Pubkey::new_from_array(state.mint));
    let amount = i128::from(amount);
    let ctx = AllowitContext {
        env: AllowitEnv::new(),
        params: AllowitParams::from(params(&state.rules, &state.params)?),
        state: policy_state,
        request: AllowitRequest {
            operation: AllowitOperation::transfer,
            asset: mint.clone(),
            recipient: address(recipient),
            amount,
            token_in: mint,
            amount_in: amount,
            token_out: None,
            min_out: 0,
            now,
            expires_at,
            spent_units: amount,
            gas_units: 0,
            unpriced: false,
            args: AllowitArgs::from(AllowitMap::new()),
        },
    };
    for &index in &state.rules {
        preflight(&ctx, RULES[usize::from(index)]).map_err(core_error)?;
    }
    let updated = post_flight(&ctx, AllowitTier::Standard).map_err(core_error)?;
    let figures = AllowitStandardState::read(&updated).map_err(core_error)?;
    Ok(Figures {
        calls: figures.calls,
        spent: figures.spent,
        day: figures.day,
        day_spent: figures.day_spent,
        day_total: figures.day_total,
    })
}

fn address(key: &Pubkey) -> Address {
    Address::new(key.to_string())
}

fn core_error(error: AllowitError) -> ProgramError {
    ProgramError::Custom(1000 + error as u32)
}
