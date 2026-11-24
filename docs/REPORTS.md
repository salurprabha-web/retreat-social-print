# Reports and analytics

Open **Event > Reports** (event managers, reporting viewers and super administrators; print operators do not have report access). Choose a period (Today, 7 days, 30 days, All time, or any dates) and a **time zone**: a "day" is a calendar day in that zone. Everything on screen is also available as **CSV** (one file per report) and as a **PDF** report, for the same period and zone. The dashboard shows the last 14 days and a table of every event you may see.

## What every number means
All numbers are counts of real records. Nothing is estimated.

| Metric | Definition |
|---|---|
| QR scans | Visits to a QR link. Staff, bots and link previews count too |
| Guests | Unique guest sessions started |
| Photos uploaded | Photos received, including ones the guest later replaced |
| Frame selections | Times a guest's chosen frame produced a picture, including tries that were replaced. Events from before this feature count one per surviving picture |
| Finished pictures | Pictures the guest finished (tapped Finish), counted on the day they finished |
| Share attempts | Taps on Instagram / WhatsApp / native share. **Never a confirmed post**: the platforms do not tell us |
| Downloads, copies | Download taps; caption / hashtag copy taps |
| Guests who shared or downloaded | Distinct guests with at least one such tap |
| Print jobs / Reprints | Jobs created (first prints / reprints), counted on the day created |
| Prints completed, paper copies | Jobs that finished successfully, and their copies, counted on the day they finished |
| Failed attempts | Print attempts that failed. A retry that later worked still counts here |
| Photo wall appearances | Times a picture was shown on the wall. **All time**: the wall keeps one running count per picture |

**Guest journey** follows the guests who *started* in the period: how many added a photo, chose a frame, finished, shared or downloaded, and got a print (whenever they got there).

**Frame popularity**: per frame, choices, finished pictures (and share of all), prints, share attempts, downloads, and the percentage of its pictures that were shared or downloaded.

**Printers**: per printer, jobs printed, copies, jobs failed, success rate and average seconds per job. Jobs count when they finish, on the printer that finished them. A job with no printer (for example delivered from a local venue server) shows as "Not assigned to a printer".

**Operators**: per signed-in person, pictures approved / rejected / hidden / deleted (counted per picture, so one bulk click on 20 pictures is 20), and print actions (approved for print, held, cancelled, retried, reprints requested). Automatic printing, the print agent and deliveries from a local server are **not attributed** to a person.

## Exports
- **CSV**: RFC 4180, UTF-8 with a byte-order mark (opens correctly in Excel, including non-English names). Text that a spreadsheet would run as a formula (starting with `=`, `+`, `-` or `@`) is neutralised with a leading apostrophe. "All pictures" lists every finished picture (guest ID, frame, moderation, prints, shares, downloads, wall appearances) with **no contact details**, up to 50,000 rows.
- **PDF**: summary, guest journey, daily chart and table, frames, printers, operators. The PDF's built-in font covers Western European characters only, so other scripts appear as `?` there; the CSV keeps them exactly.
- Every export is recorded in the audit log.

## Limits
- Deleting a picture or a guest's data removes it from the counts (privacy deletion is real deletion), so counts of what happened before a deletion shrink.
- Daily charts cover at most 366 days; with no start date they show the last 30 days, never earlier than the first recorded activity.
- Operator and printer figures are only as complete as the records: they depend on how the print agent and staff were used.
- Not built: scheduled or emailed reports, comparison between two periods, per-sponsor and per-QR-code conversion (a scan is not linked to the guest who followed it).
