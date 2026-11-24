# Test checklist: NoShow Shield

Only message opted-in test numbers.

## A. Automated
| # | Check | Command | Pass when |
|---|---|---|---|
| A1 | Unit tests | `npm test` | 10/10 pass |
| A2 | Generated workflows run end to end | `node scripts/simulate-n8n.js` | "ALL SIMULATIONS PASSED" |
| A3 | Exports match source | `npm run build && git diff --exit-code workflows/` | no diff |

## B. Live (self-hosted n8n)
| # | Do | Expected | Result |
|---|---|---|---|
| B1 | Open `/webhook/noshow-seed?key=…` | JSON listing 3 appointments + 2 waitlist entries; events appear in the calendar; Waitlist tab filled | |
| B2 | Open `/webhook/noshow-run?key=…` | WhatsApp reminder(s) arrive on the test phone; Outbox rows `reminder_2h` / `reminder_24h` with `status=sent` | |
| B3 | Run B2 again | No new reminders (dedupe) | |
| B4 | Open a reminder's link (Outbox `link` column) | Page with Confirm / Reschedule / Cancel; no phone numbers on the page | |
| B5 | Tap **Confirm** | Event turns green; description gets `Status: confirmed`; Activity row `confirmed` | |
| B6 | Tap **Reschedule**, then pick a time | Event moves; Activity `rescheduled` + `waitlist_offered`; Outbox `waitlist_offer` row with a link | |
| B7 | Open the offer link and tap **Book it** | New calendar event for the waitlisted patient; Activity `waitlist_booked` | |
| B8 | Open a second offer for the same slot and tap **Book it** | "Someone else took this slot" | |
| B9 | Cancel another appointment (two taps) | Event deleted; slot offered to the waitlist | |
| B10 | Edit a token character in a link | "This link has expired" | |
| B11 | Disconnect the Google credential, then open a link | "Please try again" page | |

## C. Definition of done
- [ ] Fictional patients only; demo messages only to the opted-in test number
- [ ] `.env` not committed; `.env.example` complete
- [ ] Loom link in the README; repo description and topics set
