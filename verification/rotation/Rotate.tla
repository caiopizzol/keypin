------------------------------- MODULE Rotate -------------------------------
(* keypin rotate, across runs, crashes and keypin publish runs between them.
   Each action is one step of apps/cli/src/commands/rotate.ts or
   apps/cli/src/publishing.ts, named in the comment above it. A step that awaits Cloudflare, 1Password, a
   destination or a saveRotations/saveState call is its own action, because a
   run can stop between any two of them. *)
EXTENDS Naturals

CONSTANTS
  Dests,       \* entry.publish of the key being rotated
  NewDests,    \* destinations added to that entry.publish later; each already holds the
               \* current token, set by hand, and has no receipt
  OtherDests,  \* entry.publish of another key or environment that reads the same vault item
  MaxTokens,   \* how many new tokens Cloudflare can make in one behavior
  OutsideEdits,\* TRUE: someone can restore an earlier version of the vault item
  LostReceipts \* TRUE: a run can stop after a destination write, before its receipt is saved

Nil == 99
Tokens == 0..MaxTokens
AllDests == Dests \cup NewDests \cup OtherDests
Stages == {"none", "issuing", "issued", "stored", "published", "revoked"}

VARIABLES
  tok,    \* Cloudflare: token -> "unmade" | "active" | "gone"
  vault,  \* the 1Password item (entry.ref): the token whose value it holds
  dest,   \* each destination secret: the token whose value it holds
  rcpt,   \* state.json: the generation (token) of each destination's latest receipt
  rot,    \* rotations.json: this key's rotation (stage "none" = no record)
  made,   \* the token Cloudflare made under rot.new.name, which "issuing" records
  pc,     \* the running keypin rotate ("idle" = none)
  wd,     \* the destination that rotate's writeAll is writing
  ppc,    \* the running keypin publish ("idle" = none)
  pk,     \* which key that publish runs for: "rotated" or "other"
  pv,     \* the vault value that publish read
  pd,     \* the destination that publish's writeAll is writing
  held,   \* every token whose value the item has held (1Password keeps old versions)
  listed  \* the rotated key's entry.publish in keypin.toml now

vars == <<listed, held, tok, vault, dest, rcpt, rot, made, pc, wd, ppc, pk, pv, pd>>

Init ==
  /\ tok = [t \in Tokens |-> IF t = 0 THEN "active" ELSE "unmade"]
  /\ vault = 0
  /\ dest = [d \in AllDests |-> 0]
  /\ rcpt = [d \in AllDests |-> IF d \in NewDests THEN Nil ELSE 0]
  /\ rot = [stage |-> "none", old |-> Nil, new |-> Nil]
  /\ made = Nil
  /\ pc = "idle"
  /\ wd = Nil
  /\ ppc = "idle"
  /\ pk = "rotated"
  /\ pv = Nil
  /\ pd = Nil
  /\ held = {0}
  /\ listed = Dests

\* locked(): rotate and publish share one lock file.
Unlocked == pc = "idle" /\ ppc = "idle"
Fresh == CHOOSE t \in Tokens : tok[t] = "unmade" /\ \A u \in Tokens : u < t => tok[u] # "unmade"
KeyDests(k) == IF k = "rotated" THEN listed ELSE OtherDests

\* ---------------------------------------------------------------- rotate

\* start(): the current value verifies as an active token that the admin token
\* can read, the user confirms, and the "issuing" record is saved.
Start ==
  /\ Unlocked
  /\ rot.stage \in {"none", "revoked"}
  /\ tok[vault] = "active"
  /\ rot' = [stage |-> "issuing", old |-> vault, new |-> Nil]  \* mutant: issue-before-record
  /\ made' = Nil
  /\ pc' = "issue"
  /\ UNCHANGED <<listed, held, tok, vault, dest, rcpt, wd, ppc, pk, pv, pd>>

\* provider.issue() makes the token. A lost response is this step plus Crash.
Issue ==
  /\ pc = "issue"
  /\ \E t \in Tokens : tok[t] = "unmade"
  /\ tok' = [tok EXCEPT ![Fresh] = "active"]
  /\ made' = Fresh
  /\ pc' = "saveIssued"
  /\ UNCHANGED <<listed, held, vault, dest, rcpt, rot, wd, ppc, pk, pv, pd>>

\* provider.issue() refuses (4xx): no token, and the record is dropped.
IssueRefused ==
  /\ pc = "issue"
  /\ rot' = [rot EXCEPT !.stage = "none"]
  /\ pc' = "idle"
  /\ UNCHANGED <<listed, held, tok, vault, dest, rcpt, made, wd, ppc, pk, pv, pd>>

\* start() saves "issued" with the new token ID.
SaveIssued ==
  /\ pc = "saveIssued"
  /\ rot' = [rot EXCEPT !.stage = "issued", !.new = made]
  /\ pc' = "check"
  /\ UNCHANGED <<listed, held, tok, vault, dest, rcpt, made, wd, ppc, pk, pv, pd>>

\* checkNew() passes or finds a problem.
CheckPasses ==
  /\ pc = "check"
  /\ pc' = "store"
  /\ UNCHANGED <<listed, held, tok, vault, dest, rcpt, rot, made, wd, ppc, pk, pv, pd>>

CheckFails ==
  /\ pc = "check"
  /\ pc' = "deleteUnchecked"
  /\ UNCHANGED <<listed, held, tok, vault, dest, rcpt, rot, made, wd, ppc, pk, pv, pd>>

\* deleteUnchecked(): revoke the new token, then drop the record.
DeleteUnchecked ==
  /\ pc = "deleteUnchecked"
  /\ tok' = [tok EXCEPT ![rot.new] = "gone"]
  /\ pc' = "drop"
  /\ UNCHANGED <<listed, held, vault, dest, rcpt, rot, made, wd, ppc, pk, pv, pd>>

\* vault.write() stores the new value in the item. A write that lands but
\* reports an error is this step plus Crash.
Store ==
  /\ pc = "store"
  /\ vault' = rot.new
  /\ held' = held \cup {rot.new}
  /\ pc' = "saveStored"
  /\ UNCHANGED <<listed, tok, dest, rcpt, rot, made, wd, ppc, pk, pv, pd>>

\* start() saves "stored".
SaveStored ==
  /\ pc = "saveStored"
  /\ rot' = [rot EXCEPT !.stage = "stored"]
  /\ pc' = "publish"
  /\ UNCHANGED <<listed, held, tok, vault, dest, rcpt, made, wd, ppc, pk, pv, pd>>

\* publishNew() -> writeAll(): destination.write() for each destination whose
\* receipt lacks the new generation, then its receipt is saved.
PublishWrite(d) ==
  /\ pc = "publish"
  /\ d \in listed
  /\ rcpt[d] # rot.new
  /\ dest' = [dest EXCEPT ![d] = rot.new]
  /\ wd' = d
  /\ pc' = "receipt"
  /\ UNCHANGED <<listed, held, tok, vault, rcpt, rot, made, ppc, pk, pv, pd>>

PublishReceipt ==
  /\ pc = "receipt"
  /\ rcpt' = [rcpt EXCEPT ![wd] = rot.new]
  /\ pc' = "publish"
  /\ UNCHANGED <<listed, held, tok, vault, dest, rot, made, wd, ppc, pk, pv, pd>>

\* publishNew() saves "published" after every write succeeded.
SavePublished ==
  /\ pc = "publish"
  /\ \A d \in listed : rcpt[d] = rot.new
  /\ rot' = [rot EXCEPT !.stage = "published"]
  /\ pc' = "idle"
  /\ UNCHANGED <<listed, held, tok, vault, dest, rcpt, made, wd, ppc, pk, pv, pd>>

\* A later run at "stored": publishNew(..., null) reads the item, which must
\* hold the new generation, and recheck() needs the old token to exist.
ResumeStored ==
  /\ Unlocked
  /\ rot.stage = "stored"
  /\ vault = rot.new
  /\ tok[rot.old] # "gone"
  /\ tok[rot.new] = "active"
  /\ pc' = "publish"
  /\ UNCHANGED <<listed, held, tok, vault, dest, rcpt, rot, made, wd, ppc, pk, pv, pd>>

\* A later run at "published": revokeOld() stops while any destination's
\* receipt lacks the new generation, while otherHolders() finds a destination
\* that a registered map lists and whose latest receipt has the old one, or when
\* the item doesn't hold the new value. It needs the new token to be active.
RevokeStart ==
  /\ Unlocked
  /\ rot.stage = "published"
  /\ \A d \in listed : rcpt[d] = rot.new  \* mutant: revoke-skips-receipts
  /\ \A d \in OtherDests : rcpt[d] # rot.old  \* mutant: revoke-skips-other-keys
  /\ vault = rot.new  \* mutant: revoke-skips-item-read
  /\ tok[rot.new] = "active"
  /\ pc' = "revoke"
  /\ UNCHANGED <<listed, held, tok, vault, dest, rcpt, rot, made, wd, ppc, pk, pv, pd>>

\* provider.revoke(old); an old token that is already gone goes straight to finish().
Revoke ==
  /\ pc = "revoke"
  /\ tok' = [tok EXCEPT ![rot.old] = "gone"]
  /\ pc' = "finish"
  /\ UNCHANGED <<listed, held, vault, dest, rcpt, rot, made, wd, ppc, pk, pv, pd>>

\* finish() saves "revoked".
Finish ==
  /\ pc = "finish"
  /\ rot' = [rot EXCEPT !.stage = "revoked"]
  /\ pc' = "idle"
  /\ UNCHANGED <<listed, held, tok, vault, dest, rcpt, made, wd, ppc, pk, pv, pd>>

\* A later run at "issuing" or "issued": abandon().
\* The item already holds the new value: the record moves to "stored".
AbandonToStored ==
  /\ Unlocked
  /\ rot.stage \in {"issuing", "issued"}
  /\ rot.new # Nil
  /\ vault = rot.new
  /\ rot' = [rot EXCEPT !.stage = "stored"]
  /\ UNCHANGED <<listed, held, tok, vault, dest, rcpt, made, pc, wd, ppc, pk, pv, pd>>

\* The item holds the old value and no latest receipt has the new one: the new
\* token is deleted, then the record dropped.
AbandonDelete ==
  /\ Unlocked
  /\ rot.stage \in {"issuing", "issued"}
  /\ rot.new # Nil
  /\ vault = rot.old  \* mutant: abandon-skips-item-read
  /\ \A d \in AllDests : rcpt[d] # rot.new  \* mutant: abandon-skips-receipts
  /\ tok' = [tok EXCEPT ![rot.new] = "gone"]
  /\ pc' = "drop"
  /\ UNCHANGED <<listed, held, vault, dest, rcpt, rot, made, wd, ppc, pk, pv, pd>>

\* The record has no token ID: keypin names rot.new.name, and the user deletes
\* that token in the dashboard if Cloudflare made it (an assumption).
AbandonForget ==
  /\ Unlocked
  /\ rot.stage = "issuing"
  /\ rot.new = Nil
  /\ tok' = IF made # Nil THEN [tok EXCEPT ![made] = "gone"] ELSE tok
  /\ pc' = "drop"
  /\ UNCHANGED <<listed, held, vault, dest, rcpt, rot, made, wd, ppc, pk, pv, pd>>

\* deleteUnchecked() or abandon() drops the record.
Drop ==
  /\ pc = "drop"
  /\ rot' = [rot EXCEPT !.stage = "none"]
  /\ pc' = "idle"
  /\ UNCHANGED <<listed, held, tok, vault, dest, rcpt, made, wd, ppc, pk, pv, pd>>

\* Any failure, refusal or kill ends the run; files keep what was saved.
Crash ==
  /\ pc # "idle"
  /\ LostReceipts \/ pc # "receipt"
  /\ pc' = "idle"
  /\ UNCHANGED <<listed, held, tok, vault, dest, rcpt, rot, made, wd, ppc, pk, pv, pd>>

\* ---------------------------------------------------------------- outside keypin

\* Between runs, someone restores an earlier version of the 1Password item whose
\* token still works. rotate.ts guards for this ("Something else changed it")
\* when it resumes at "issuing", "issued" or "stored".
ItemEdited(t) ==
  /\ OutsideEdits
  /\ Unlocked
  /\ t \in held
  /\ tok[t] = "active"
  /\ t # vault
  /\ vault' = t
  /\ UNCHANGED <<listed, held, tok, dest, rcpt, rot, made, pc, wd, ppc, pk, pv, pd>>

\* Between runs, someone adds a destination to keypin.toml. It already holds the
\* item's working token, set by hand (assumption: it works when it joins).
AddDest(d) ==
  /\ Unlocked
  /\ d \in NewDests \ listed
  /\ tok[dest[d]] = "active"
  /\ listed' = listed \cup {d}
  /\ UNCHANGED <<held, tok, vault, dest, rcpt, rot, made, pc, wd, ppc, pk, pv, pd>>

\* ---------------------------------------------------------------- publish

\* keypin publish <key> between rotate runs: reads the item, then writeAll().
PubStart(k) ==
  /\ Unlocked
  /\ KeyDests(k) # {}
  /\ ppc' = "run"
  /\ pk' = k
  /\ pv' = vault
  /\ UNCHANGED <<listed, held, tok, vault, dest, rcpt, rot, made, pc, wd, pd>>

\* publish.ts writeAll(): destination.write(), then its receipt is saved.
PubWrite(d) ==
  /\ ppc = "run"
  /\ d \in KeyDests(pk)
  /\ rcpt[d] # pv
  /\ dest' = [dest EXCEPT ![d] = pv]
  /\ pd' = d
  /\ ppc' = "receipt"
  /\ UNCHANGED <<listed, held, tok, vault, rcpt, rot, made, pc, wd, pk, pv>>

PubReceipt ==
  /\ ppc = "receipt"
  /\ rcpt' = [rcpt EXCEPT ![pd] = pv]
  /\ ppc' = "run"
  /\ UNCHANGED <<listed, held, tok, vault, dest, rot, made, pc, wd, pk, pv, pd>>

PubEnd ==
  /\ ppc # "idle"
  /\ LostReceipts \/ ppc # "receipt"
  /\ ppc' = "idle"
  /\ UNCHANGED <<listed, held, tok, vault, dest, rcpt, rot, made, pc, wd, pk, pv, pd>>

Next ==
  \/ Start \/ Issue \/ IssueRefused \/ SaveIssued \/ CheckPasses \/ CheckFails
  \/ DeleteUnchecked \/ Store \/ SaveStored
  \/ \E d \in AllDests : PublishWrite(d)
  \/ PublishReceipt \/ SavePublished \/ ResumeStored
  \/ RevokeStart \/ Revoke \/ Finish
  \/ AbandonToStored \/ AbandonDelete \/ AbandonForget \/ Drop \/ Crash
  \/ \E k \in {"rotated", "other"} : PubStart(k)
  \/ \E d \in AllDests : PubWrite(d)
  \/ PubReceipt \/ PubEnd
  \/ \E t \in Tokens : ItemEdited(t)
  \/ \E d \in NewDests : AddDest(d)

Spec == Init /\ [][Next]_vars

\* ---------------------------------------------------------------- rules

TypeOK ==
  /\ tok \in [Tokens -> {"unmade", "active", "gone"}]
  /\ vault \in Tokens
  /\ dest \in [AllDests -> Tokens]
  /\ rcpt \in [AllDests -> Tokens \cup {Nil}]
  /\ listed \subseteq Dests \cup NewDests
  /\ rot.stage \in Stages
  /\ made \in Tokens \cup {Nil}
  /\ held \subseteq Tokens

\* Every destination that a keypin.toml lists for the item holds a token that works.
DestinationsWork == \A d \in listed \cup OtherDests : tok[dest[d]] = "active"

\* The vault item holds a token that works.
VaultWorks == tok[vault] = "active"

\* Every working token is in use, or rotations.json still records it.
NoForgottenToken ==
  \A t \in Tokens : tok[t] = "active" =>
    \/ t = vault
    \/ \E d \in AllDests : dest[d] = t
    \/ rot.stage \notin {"none", "revoked"} /\ t \in {rot.old, rot.new, made}
=============================================================================
