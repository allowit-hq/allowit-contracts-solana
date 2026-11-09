import type {StellarInstallation} from '@allowit/engine/stellar/runtime';
import type {Network,NetworkConfig} from '../wallet/networks';
import type {AuthController} from '../useApp';
import type {OperationReceipt} from '../paysh/paysh-units';
import type {OwnerRequestKind} from '../owner/owner-requests';
import type {RuntimeConfig,RuntimeChoice} from '../runtime/runtime';
import type {ContractSetupController} from '../runtime/useContractSetup';
import type {AuthorizationController} from '../runtime/useOwnerAuthorization';
export interface Turn {role:'user'|'assistant'|'system'; text:string; revision:number}
export interface UsageEvent {id:string; at:string; kind:'judgment'|'transaction'; outcome:'allowed'|'denied'|'awaiting_input'; amount:string; token:string; detail:string}
/** origin 'policy_api' marks a call to a function defined in the pinned native policy_api.rs. */
export interface WorkflowNode {origin?:'policy_api';score_thresholds?:{field:string;operator:string;value_bps:number}[];id:string;kind:'function'|'custom'|'pass'|'preference';name:string;label:string;description:string;arguments:string[];source:string;start:number;end:number}
export type WorkflowStepStatus='passed'|'verifying'|'failed'|'inactive'|'skipped'|'awaiting_input';
export interface WorkflowTraceStep {nodeId:string;status:WorkflowStepStatus;visited:boolean}
export interface WorkflowTrace {version:1;sourceHash:string;irHash:string;complete:boolean;steps:WorkflowTraceStep[]}
/** `question` is sent only when the owner rewrote it; the server replaces that step's question in source. */
export interface PreferenceSettings {thresholds?:number[];stepId:string;autoApprove:boolean;approvePercent:string;autoDeny:boolean;denyPercent:string;question?:string}
export interface PolicyCall {name:string;start:number;end:number}
/** `typedSignature` is unchecked registry data; only `parseTypedMetadata` reads it, and only for a typed policy. */
export interface FunctionHelp {name:string;title:string;description:string;typedSignature?:unknown}
export interface ExecutionCall {type:"contract_call";contract:string;method:string;args:Record<string,unknown>;maxCostUSDC:string}
export interface ExecutionPlan {rail:"solana"|"stellar";asset:"SOL"|"XLM"|"USDC";quantity:string;memo?:string;data?:string;before?:ExecutionCall[];after?:ExecutionCall[]}
/**
 * sourceHash, revision and workflowNodeId bind a decision to the exact compiled step it stopped at.
 * The server maps the Rust evaluator's source span to a registered node; host gates have no node.
 */
/** Legacy owner-wallet request states. */
export type LegacyRequestStatus='evaluating'|'awaiting_input'|'ready'|'submitted'|'settled'|'recorded'|'denied';
/** Coordinator phases, preserved as the server reports them. Decision, settlement and delivery stay independent. */
export type CoordinatorStatus='evaluating'|'awaiting_input'|'owner_approved'|'approved'|'preparing'|'signed'|'submitted'|'confirmed'|'delivering'|'delivered'|'denied'|'failed'|'expired'|'settlement_unknown'|'unknown';
export type RequestStatus=LegacyRequestStatus|CoordinatorStatus;
export type SettlementStatus='not_started'|'preparing'|'signed'|'submitted'|'pending'|'partially_finalized'|'finalized'|'failed'|'unknown';
export type DeliveryStatus='not_started'|'pending'|'delivered'|'unknown';
/** Server settlement record. Receipts keep the native OperationReceipt fields; integers stay decimal strings. */
export interface RequestSettlement {status:SettlementStatus;signatures:string[];receipts:OperationReceipt[]}
/** `response` is the provider reply as data. It is shown as bounded text, never as HTML. */
export interface RequestDelivery {status:DeliveryStatus;response?:unknown}
/** The server's explicit owner-decision reference. The client never derives one for a contract wallet. */
export interface OwnerRequestReference {kind:OwnerRequestKind;policyId:string;requestId:string}
export interface PolicyRequest {requestHash?:string;settlement?:RequestSettlement;delivery?:RequestDelivery;ownerRequest?:OwnerRequestReference;ownerRef?:OwnerRequestReference;policyId?:string;sourceHash:string;revision:number;workflowTrace?:WorkflowTrace;workflowNodeId?:string;decisionCode?:string;runId?:string;execution?:ExecutionPlan;id:string;kind:'judgment'|'transaction'|'provider_call';amount:string;token:string;action:string;merchant:string;recipient?:string;status:RequestStatus;reason:string;prompt?:string;inputKey?:string;signature?:string;createdAt:string;expiresAt:string;providerCandidate?:ProviderCandidate;providerReputation?:ProviderReputation;providerFeedback?:{value:1|-1;weight:4|8};feedbackEligible?:boolean}
/** Registered catalog metadata for the assessed candidate; no verified identity or delivery claim. */
export interface ProviderCandidate {providerId:string;name:string;gatewayUrl:string;provider:string;service:string;network:string;subject:string;recipient:string}
export interface ReputationTally {good:number;bad:number;support:number}
export interface ProviderReputation {version:1;policy:ReputationTally;owner:ReputationTally;system:ReputationTally}
/**
 * One recorded run event: progress notes and tool I/O from the agent, status changes and policy
 * decisions from the server. Provider reasoning is never an event. `sequence` is the ingestion id;
 * `at` is when the event happened. `data` is a redacted, bounded payload shown verbatim.
 */
export interface AgentEvent {sequence:number;at:string;kind:'status'|'progress'|'tool_call'|'tool_result'|'policy';message?:string;tool?:string;callId?:string;data?:string;requestId?:string;workflowNodeId?:string;status?:string;code?:string}
export interface AgentRun {id:string;status:'starting'|'running'|'stopping'|'stopped'|'completed'|'failed';startedAt:string;expiresAt:string;finishedAt?:string;message?:string;output?:string;events?:AgentEvent[];eventsTruncated?:boolean}
/** Requested initial funding. It does not report a deposit or authorize a transfer. */
export interface FundingRequest {amount:string;token:string}
export type WalletKind='owner-wallet'|'contract-wallet';
/** The request kinds a registered operation can admit. `execution-request` needs no service; `curl-request` needs one. */
export type IngressKind='execution-request'|'curl-request';
/** How a typed policy is funded, as the server states it. Absent keeps the original path for the wallet kind. */
export type FundingMode='authorization'|'deposit'|'spl-delegate'|'stellar-installed';
/** Immutable owner-wallet authority. Its live status and counters are read from delegate/grants, never policy.status. */
export interface DelegatedExecution {version:1;grantId:string;owner:string;policyId:string;revision:number;sourceHash:string;irHash:string;intentHash:string;displayNetwork:string;network:string;genesisHash:string;mint:string;sourceAccount:string;delegate:string;budgetUnits:string;expiresAt:number;commitmentHash:string}
/**
 * Actions the policy's wallet supports. Not the agent capability token. `typedIngress`, when the server states it, is
 * the exact list of request kinds the wallet or policy admits; it is never inferred from `providerCall`.
 */
export interface RuntimeCapabilities {discard?:boolean;providerCall:boolean;fund:boolean;withdraw:boolean;revoke:boolean;revise:boolean;fork:boolean;rename:boolean;typedIngress?:IngressKind[]}
/** The asset the policy's wallet is funded with: Testnet SOL for a contract wallet. */
export interface FundingAsset {network:string;symbol:string;decimals:number}
/** The configured token payments and receipts are counted in. Its symbol is shown as stored, never as USDC by inference. */
export interface PaymentAsset {network:string;symbol:string;decimals:number;mint:string}
/** Server-reported setup progress for a contract wallet. Fields are shown only when the server sends them. */
export interface RuntimeSetupEvidence {status:string;signature:string|null;policy:{id:string;owner:string;policyAddress:string;network:string};chain:{initialized:boolean;policyAddress:string;owner:string;solVault:string;finalizedSlot?:string}|null}
export interface RuntimeSetup {state?:RuntimeSetupEvidence;status?:string;requestId?:string;signature?:string;policyAccount?:string;expiresAt?:string}
/**
 * Fixed at generation. `sourceProfile` is the backend runtime; `wallet.profile` is the wallet adapter. `operation` is
 * the registered provider operation, null for an ordinary owner-wallet policy.
 */
/** Compiler-owned static operation requirements. Amounts stay exact base-unit integers. */
export interface ProviderCallRequirement {operation:string;payment_asset_id:string;service_id:string;input_key:string;max_payment_units:string;max_swap_lamports:string;max_service_fee_lamports_per_execution:string}
export type {StellarInstallation} from '@allowit/engine/stellar/runtime';

export interface PolicyRuntime {instanceBinding?:Record<string,unknown>;authorization?:unknown;stellarInstallation?:StellarInstallation;sourceProfile:string;wallet:{kind:WalletKind;profile:string};capabilities:RuntimeCapabilities;fundingAsset:FundingAsset;paymentAsset:PaymentAsset;operation:string|null;providerCallRequirements?:ProviderCallRequirement[];setup?:RuntimeSetup|null;fundingMode?:FundingMode}
/**
 * `originalIntent` is the owner's stored words, exact; a new contract-wallet setup binds its hash. The typed fields are
 * unchecked compiler metadata, all present or all absent; they are shown only after `validateTypedMetadata` accepts them.
 * `typedBudgetRequirements` is unchecked compiler output and `assetMetadata` unchecked host asset labels; both are shown
 * only through the same checked view.
 */
export interface MicroPolicy {delegatedExecution?:DelegatedExecution;nativeExecution?:{policyId:string;revocationStarted:boolean};registryVersion?:unknown;typeDeclarations?:unknown;typedWorkflowRequirements?:unknown;typedBudgetRequirements?:unknown;assetMetadata?:unknown;originalIntent?:string;runtime?:PolicyRuntime;fundingRequest?:FundingRequest;constructorSource?:string;spentAmount?:string;availableAmount?:string;agent?:AgentRun;language:'allowit-rust-v1'|'legacy';sourceHash:string;irHash:string;workflow:WorkflowNode[];calls:PolicyCall[];functionHelp:FunctionHelp[];requests:PolicyRequest[];spentUnits:number;mint:string;network:Network; id:string; parentId?:string; approvalPending?:boolean; title:string; explanation:string; code:string; limit:string; token:string; revision:number; status:'draft'|'active'|'cancelling'|'cancelled'; turns:Turn[]; createdAt:string; updatedAt:string; allocation?:{amount:string;token:string;signature:string;address:string}; activity:UsageEvent[]}
export interface PolicyRevocation {owner:string;total:number;completed:number;currentTitle:string;status:'running'|'completed'|'failed';message:string;walletRequired?:boolean}
/**
 * Client progress for one wallet transaction. `signing` lasts until the wallet returns. The wallet both signs and
 * broadcasts, so `finalizing` begins as soon as it returns and keeps the signature until the server reports finality.
 * `checking` is false when a bounded check ended without finality; the transaction may still finalize.
 * `unknown` means the wallet returned without a signature, so it may or may not have broadcast.
 */
export interface TxProgress {phase:'signing'|'finalizing'|'unknown';signature?:string;checking:boolean;message?:string}
export interface MicroController {
 /** Uses the same synchronous lock as generation, navigation and legacy wallet actions. */
 runExternal?:(name:string,work:(isCurrent:()=>boolean)=>Promise<void>)=>Promise<boolean>;
 revokeAll:(beforeCancel?:(isCurrent:()=>boolean)=>Promise<void>)=>Promise<boolean>;revocation:PolicyRevocation|null;
 network:Network; networks:NetworkConfig[]; setNetwork:(network:Network)=>void;
 auth:AuthController; policiesLoaded?:boolean; policies:MicroPolicy[]; selected:MicroPolicy|null; loading:boolean; busy:string|null; error:string|null; renameError?:string|null; harnessPrompt:string|null;skill:string|null;
 rename:(title:string)=>Promise<boolean>;
 configurePreference:(settings:PreferenceSettings)=>Promise<boolean>;
 /** Sets a draft's service whitelist: each service ID with the only recipient it may be paid. An empty list removes it. */
 setRecipient:(recipient:string)=>Promise<boolean>;
 setWhitelist:(entries:{id:string;recipient:string}[])=>Promise<boolean>;
 /** Selects one trusted server-advertised native x402 service. An empty ID removes the draft selection. */
 setNativeX402Service:(serviceId:string)=>Promise<boolean>;
 /** Sets the exact USDC funding request of an unbound Devnet draft. Its rules are unchanged; nothing is signed or moved. */
 setFunding:(amount:string)=>Promise<boolean>;
 /** Forks the selected policy and saves these preference settings to the new draft. The original stays unchanged. */
 forkPreference:(settings:PreferenceSettings)=>Promise<boolean>;
 /**
  * Local dev only: records a wallet-free simulated answer for a local:dev policy in the anonymous local_* workspace. It
  * moves no funds. Every other owner question is answered only through the signed owner inbox, never from here.
  */
 answerLocal:(requestId:string,approved:boolean)=>Promise<void>;
 /** Saves the owner's provider-fit feedback. The server decides eligibility; the request itself is unchanged. */
 feedback:(requestId:string,feedback:1|-1)=>Promise<void>;
 execute:(requestId:string)=>Promise<void>;migrate:()=>Promise<void>;
 /** GET micro/runtime. Null until loaded; `unavailable` when the server has no runtime registry. */
 runtimeConfig:RuntimeConfig|null|'unavailable';
 /** The registry request failed for a reason other than an absent route; new policies then use the original body. */
 runtimeConfigFailed:boolean;
 /** Owner-session run list for the selected policy, when the server provides one. */
 runs:{policyId:string;requests:PolicyRequest[]}|null;
 /** Owner-session run detail, including any delivered response. Scoped to the owner and policy that asked. */
 requestDetail:(policyId:string,requestId:string)=>Promise<PolicyRequest|null>;
 setup:ContractSetupController;
 /** Owner-wallet budget authorization for the selected policy. */
 authorization:AuthorizationController;
 select:(id:string|null)=>void; generate:(prompt:string,runtime?:RuntimeChoice,stellarInstallationId?:string)=>Promise<boolean>; revise:(prompt:string)=>Promise<boolean>; fork:()=>Promise<void>; approve:(amount:string,token:string)=>Promise<void>; cancel:()=>Promise<void>;
 /** Checks a signed allowance transaction again with its saved signature. Never asks the wallet to sign. */
 recheckAllocation:(kind:'approve'|'cancel')=>Promise<void>;
 txProgress:(kind:'request'|'allocation',policyId:string,id:string)=>TxProgress|null; handoff:()=>Promise<void>; refresh:()=>Promise<void>; dismissError:()=>void; errorCode?:string; releaseAllowance?:()=>Promise<void>;
}
export const MICRO_EXAMPLES=[
 {title:'Research with primary evidence',prompt:'Let my agent spend up to 10 USDC on this research task, at most 1 USDC per purchase. Allow at most 2 purchases above 0.50 up to 1 USDC, at most 4 purchases above 0.25 up to 0.50 USDC, and continue halving each price ceiling and doubling its purchase count for cheaper bands, without a minimum purchase amount, and only for the research action. Pay only for material that adds primary evidence: original datasets, filings, transcripts, interviews, court or regulatory documents, or the source paper itself. Do not pay for newsletters, summaries, digests or reports that repackage sources I could read directly. If it is unclear whether a purchase adds primary evidence, ask me before paying.'},
 {title:'Investments with operating evidence',prompt:'Allow my agent to place investments up to 300 USDC in total and 75 USDC per position. Do not invest where the case rests on hype: endorsements, social momentum, price charts or projected upside without operating evidence such as revenue, paying customers, a shipped product or audited figures. If operating evidence exists but is thin, unaudited or contradicted elsewhere, ask me before the position is opened.'},
 {title:'Green investments within 1 point',prompt:'Let my agent invest up to 500 USDC in total, at most 100 USDC per position. Prefer green investments whose environmental claims are substantiated by an independent party, not only by the issuer\'s own marketing. Accept a green option when its estimated expected annual return is within 1 percentage point below a comparable conventional benchmark; these are estimates, not guaranteed returns. Decline if the estimated return gap is wider than 1 percentage point. If the only environmental substantiation is the issuer\'s own claim, ask me before proceeding.'},
];
/**
 * The workflow step where this request stopped, as recorded by the server. It matches only a denied or
 * waiting request decided against this exact source and revision whose node id is a step in this
 * workflow. Host checks have no node. The reason and decision code are never parsed.
 */
export function haltedStep(policy:Pick<MicroPolicy,'sourceHash'|'revision'|'workflow'>,request:Pick<PolicyRequest,'status'|'sourceHash'|'revision'|'workflowNodeId'>|null|undefined):WorkflowNode|null{
 if(!request||(request.status!=='awaiting_input'&&request.status!=='denied'))return null;
 if(!request.workflowNodeId||!policy.sourceHash||request.sourceHash!==policy.sourceHash||request.revision!==policy.revision)return null;
 return (policy.workflow??[]).find(n=>n.id===request.workflowNodeId)??null;
}
/**
 * The step a policy event points at. Events carry no source hash, so the event's request is looked up
 * on this policy and must itself resolve to the same node through haltedStep.
 */
export function eventStep(policy:Pick<MicroPolicy,'sourceHash'|'revision'|'workflow'|'requests'>,event:Pick<AgentEvent,'kind'|'requestId'|'workflowNodeId'>):WorkflowNode|null{
 if(event.kind!=='policy'||!event.requestId||!event.workflowNodeId)return null;
 const node=haltedStep(policy,(policy.requests??[]).find(r=>r.id===event.requestId));
 return node&&node.id===event.workflowNodeId?node:null;
}
/** Events in the order they happened: by time, then ingestion sequence. Unparseable times go last, by sequence. */
export function orderEvents(events:readonly AgentEvent[]):AgentEvent[]{
 const time=(e:AgentEvent)=>{const t=Date.parse(e.at);return Number.isFinite(t)?t:Number.POSITIVE_INFINITY;};
 return [...events].sort((a,b)=>{const ta=time(a),tb=time(b);return ta===tb?a.sequence-b.sequence:ta<tb?-1:1;});
}
