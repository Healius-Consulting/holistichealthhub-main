# Hold declined pharmacy requests (one-off, Step 0)

Turns every `DECLINED` `PharmacyOnboardingRequest` into `ON_HOLD`, keeping `declineReason` as the hold
reason, so HHH admin can Unhold them. Sends no emails. Production is `hhh26-4ebd2`: there is no staging, so
this changes real data.

1. Deploy the Data Connect schema that adds `ON_HOLD` first (then functions, then frontend).
2. Run `ListDeclinedPharmacyRequests` from `hold-declined-pharmacy-requests.gql` (Data Connect console, or
   `dataConnect.executeGraphql` with an admin SDK) and save the rows. Rows with an `organisationId` came from
   the organisation-level Reject (the pharmacy was archived); they become on-hold requests too.
3. Run `HoldDeclinedPharmacyRequests`. It returns the number of rows changed; it should match step 2.
4. Run the list again: it should return nothing. Once no row uses `DECLINED`, drop it from the enum in the
   Step 8 sweep.

The API already reads any leftover `DECLINED` row as on hold, so the order of steps 2 to 4 relative to the
functions deploy does not break the admin page.
