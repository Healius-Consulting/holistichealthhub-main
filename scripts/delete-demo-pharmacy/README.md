# Delete a demo pharmacy

Deletes every record of a demo or test pharmacy by its GPhC premises number, on production
(`hhh26-4ebd2`), so it can go through onboarding again. Used for the HHH demo pharmacy
(GPhC 9012605), which shows partners how onboarding works on the live platform.

```bash
scripts/delete-demo-pharmacy/delete-demo-pharmacy.sh 9012605
```

It lists the branch, onboarding request, staff logins and ClickUp card it found, asks you to
type the GPhC number again, then deletes in **one transaction**: if anything still points at
the branch (patients, orders, payments), the database refuses and nothing is deleted. Last, it
removes the request's stored files (the filled Curaleaf form and any licence).

Removed: the branch, its onboarding request(s), Partner Terms acceptances, Worldpay form notes,
eligibility referral link, setup tasks, checklist ticks, integration connections, the branch's
staff logins with their sessions and audit entries, the ClickUp card record and sync queue, the
PharmSmart visit and "Not yet" records.

Not removed: the sent-email log, and the task on the ClickUp board itself (delete it in ClickUp).

The admin portal does the same from **Demo pharmacies** (Delete now), and the API does it by
itself when a demo GPhC number sends a new Curaleaf form. Only numbers on the demo list can be
deleted there; this script has no such guard, so **never run it on a real pharmacy's number**.

Needs the `firebase` CLI and `gcloud`, both signed in.
