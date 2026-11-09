import type {DelegateConfig,DelegateGrant,DelegatePendingRequest} from './delegate-contracts';
export interface DelegateWorkspaceState {sessionKey:string;grants:DelegateGrant[];config:DelegateConfig|null;paymentReady:boolean;loaded:boolean;error:string|null;requests:DelegatePendingRequest[];answeredRequests:DelegatePendingRequest[];closedRequests:DelegatePendingRequest[];requestError:string|null}
export const emptyDelegateState=(sessionKey:string):DelegateWorkspaceState=>({sessionKey,grants:[],config:null,paymentReady:false,loaded:false,error:null,requests:[],answeredRequests:[],closedRequests:[],requestError:null});
/** A failed owner B load can retain B's own history, never relabel owner A's records as B. */
export function delegateLoadFailure(previous:DelegateWorkspaceState,sessionKey:string,message:string,unread=false):DelegateWorkspaceState {
 const same=previous.sessionKey===sessionKey;
 return {...(same?previous:emptyDelegateState(sessionKey)),...(unread?{loaded:false}:{}),paymentReady:false,error:message};
}
