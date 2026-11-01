import NativeDaily
open AllowIt.NativeDaily

def read64 (s : String) : IO U64 := do
  match s.toNat? with
  | none => throw (IO.userError "Invalid unsigned integer")
  | some n =>
    if h : n < 2 ^ 64 then pure ⟨n, h⟩
    else throw (IO.userError "Input exceeds u64")

def render (c : Context) : String :=
  match evaluate c with
  | .ok n => "ok " ++ toString n.val
  | .error .notApproved => "err NotApproved"
  | .error .zeroAmount => "err ZeroAmount"
  | .error .parameterOutOfBounds => "err ParameterOutOfBounds"
  | .error .clockWentBackwards => "err ClockWentBackwards"
  | .error .overflow => "err Overflow"
  | .error .dailyLimitExceeded => "err DailyLimitExceeded"

partial def replay (input : IO.FS.Stream) : IO Unit := do
  let line ← input.getLine
  if line.isEmpty then return
  let [flag, amount, limit, spent, spentDay, now] := line.trim.splitOn " "
    | throw (IO.userError "Expected six context fields")
  let approved ← match flag with
    | "true" => pure true
    | "false" => pure false
    | _ => throw (IO.userError "Invalid approval field")
  let amount ← read64 amount
  let dailyLimit ← read64 limit
  let spent ← read64 spent
  let spentDay ← read64 spentDay
  let now ← read64 now
  let context : Context := { approved, amount, dailyLimit, spent, spentDay, now }
  IO.println (render context)
  replay input

def main : IO Unit := do replay (← IO.getStdin)
