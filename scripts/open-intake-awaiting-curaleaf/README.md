# Open intake for pharmacies awaiting Curaleaf (one-off, Step 1)

Switches the eligibility link (`intakeEnabled`) on for every `ONBOARDING` ("Awaiting Curaleaf") pharmacy
already in production. Pharmacies activated from now on get it on at Activate. Leaves archived pharmacies,
the Platform Test pharmacies (Primary, Alternate, Tertiary) and `TRAINING-` GPhC numbers alone. Sends no
emails and does not change any status, so ordering and payment stay shut until each pharmacy goes Live.
Production is `hhh26-4ebd2`: there is no staging, so this changes real data.

1. Deploy the functions first (`firebase deploy --only functions:hhh-api --project hhh26-4ebd2`). That
   deploy is what keeps ordering, payments and Curaleaf shut for an `ONBOARDING` pharmacy whose link is on,
   and it no longer turns the link on at go-live, so run steps 2 to 4 soon after it.
2. Run `ListAwaitingCuraleafIntakeOff` from `open-intake-awaiting-curaleaf.gql` (Data Connect console, or
   `firebase dataconnect:execute` as in the handoff's production notes) and save the rows.
3. Check them: each should be a real branch awaiting Curaleaf, with no Platform Test, `TRAINING-` or
   rejected pharmacy among them. If one should stay off, stop and leave it out before going on.
4. Run `OpenIntakeForAwaitingCuraleaf`. It returns the number of rows changed; it should match step 2.
5. Run the list again: it should return nothing.
