# Team invites: company-paid seats (plan, 2026-11-18)

## DECIDED 2026-11-18 (supersedes the Stripe steps below for early access)
- $1 early access is per COMPANY, not per person. The limited number of early-access subscribers counts shops.
- Team seats are FREE during early access, capped at **3 representatives + the admin = 4 per shop**.
  The same cap applies to suppliers when their side comes in.
- Cap rule: Company_Representatives rows for the shop that are not Cancelled must be 4 or fewer
  (the admin row counts). At the cap, Invite is replaced by "Contact us to add more seats".
- So no Stripe work now: invite → email → Join → Active. The Stripe seat charge (steps 2–3 below) is added
  at the Send-invite step when real pricing starts.
- Form: MFG Company Representatives. Fields seen: Manufacture (lookup, required), Manufacture Bi Directional
  Lookup, Location, Name, Position (single line), Email, Direct Phone Number, Extension, Mobile, ACTIVE (radio),
  Employee Status (radio), Monthly Subscription, Account ID, Admin_Email, Admin Email.
- New fields: Invite_Status (radio Invited / Joined / Cancelled; blank = existing rep = Joined), Invite_Sent (date-time).
- Position stays single line in Zoho (keeps field references). The invite page offers only the fixed list.


Mark's rules:
- Nobody becomes an active representative without a paid seat. No workaround.
- The company pays per seat (option b). The invitee does not pay.
- The admin can invite people by email, and the invite onboards them.

## Flow

1. **Invite.** Manufacture Profile › REPRESENTATIVES › **+ Invite team member** opens the Railway page
   `/takeoff/team.html?manufacturer_id=…&t=…`. The admin enters first name, last name, email and position.
2. **Pay for the seat.** **Pay & send invite** has the server create a Stripe Checkout Session. One seat,
   `client_reference_id = <invite id>`, customer email = the admin.
3. **Stripe webhook** `POST /api/stripe/webhook` (checkout.session.completed; the signature is verified).
   - The seat is marked paid.
   - A Company_Representatives row is created with **Status = Invited**. It is not active and has no access.
   - The invite email goes out through Resend from no_reply@materialcompass.us. The Join link is signed
     (token kind "i": invite id + email, 14-day expiry).
4. **Join.** The invitee clicks Join and lands on `/takeoff/join.html`, which shows "Black Rock Fabrication
   invited you". Clicking **Accept** makes the server:
   - set the rep to Status = Active;
   - append the email to Customer_Entry_Form.Account_User_Email (comma-padded, the existing pattern);
   - trigger the portal invite. A Zoho function calls `thisapp.portal.assignUserInProfile(email, <profile>)`,
     and Zoho sends its set-password email.
5. **Manage.** The pending row shows *Invite sent <date>* with **Resend** and **Cancel**.
   - Cancel frees the paid seat, so the next invite uses it with no new charge.
   - Seats = paid seats − active reps − pending invites.

## Positions (fixed list, Mark: "your call")

| Position | What it is for |
|---|---|
| Administrator | Profile, billing, inviting the team. At least one per shop. |
| Estimator | Quotes, take-off, RFQs. |
| Project Manager | Projects, work orders, schedule. |
| Purchasing | Supplier RFQs, POs, material sourcing. |
| Production Manager | Work orders, time sheets, shop floor. |
| Accounting | Invoices, costs, labor totals. |

Every position sees the whole shop for now. Only **Administrator** gets Invite and billing.
Per-position permissions come later and the list is ready for them.

## Closes the workaround

- Registration Form › **Add Representative** tab: hide it once invites are live. The only way in is an
  invite paid by the company.
- Company_Representatives created by hand (admin in Zoho) are still possible for Mark as app owner.
  This is not visible to shops.

## Needs from Mark before the build

1. **Seat price and billing period.** Today it is one-time $1 early access. Seats could match that, or be
   monthly. Never invent a number.
2. **Stripe secret key** set as Railway variable `STRIPE_SECRET_KEY`, and a webhook endpoint added in
   Stripe with its signing secret in `STRIPE_WEBHOOK_SECRET`. Mark enters both himself; keep them out of chat.
3. Company_Representatives: add **Status** (Invited / Active / Cancelled) if Employee Status cannot carry
   it. Change **Position** to a dropdown with the list above.
4. Name of the portal **profile** reps are assigned to.

## Later

- Recurring per-seat billing: a Stripe subscription with quantity = seats replaces the one-time charge.
  Tie this in with the parked Zoho Billing / pricing decision.
- Deactivating a rep removes their email from Account_User_Email and frees the seat.
