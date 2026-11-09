import {address} from '@solana/kit';

/** Explicit public addresses only; never default to a developer's wallet. */
export function configuredAddresses(name:string, many=false):string[]{
  try{
    const values=new URLSearchParams(location.search).getAll(name);
    if(!values.length||(!many&&values.length!==1))throw new Error(`Укажите параметр ${name} в адресе страницы.`);
    const valid=values.map(value=>String(address(value)));
    if(new Set(valid).size!==valid.length)throw new Error(`Параметр ${name} содержит повторяющиеся адреса.`);
    return valid;
  }catch(error){
    const root=document.querySelector<HTMLElement>('main');
    if(root)root.textContent=`Настройте Testnet-инструмент: ${error instanceof Error?error.message:String(error)} Параметры: owner для создания mint; mint, authority и recipient (можно несколько) для пополнения. Только публичные Solana-адреса.`;
    throw error;
  }
}
