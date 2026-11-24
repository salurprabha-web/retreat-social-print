# Retreat Print Agent (Windows)

The agent is the bridge between the cloud platform and the printers attached to one Windows computer:

```
Guest site -> API -> print queue -> Retreat Print Agent -> Windows printer driver -> printer
```

It never opens a browser print dialog. It asks the server for the next approved job, downloads the exact final image, prints it through the normal Windows driver, and reports the result.

## What you need
- Windows 10 or 11 (64-bit) on the print computer, with internet access to the platform's address.
- The printer's own Windows driver, installed and tested from Windows first (DNP, Mitsubishi, Epson, Canon or any other). The agent uses whatever the driver offers.
- An administrator account to install. The agent itself runs as the normal user (printer drivers are per user).

## Install
1. Build the package on a development machine: `powershell -ExecutionPolicy Bypass -File apps\print-agent\installer\build.ps1`. It runs the tests, publishes a self-contained build (no .NET needed on the print computer) and creates `dist\RetreatPrintAgent-<version>-win-x64.zip` with a SHA-256 file.
2. Copy and unzip it on the print computer. Right-click `install.ps1` and choose Run with PowerShell (as administrator).
3. Open **Retreat Print Agent** from the Start Menu. It lives in the tray; closing the window does not stop printing. "Start with Windows" is on by default.
4. A standard `setup.exe` can be built with Inno Setup from `installer\RetreatPrintAgent.iss` (not built in this repository's checks: Inno Setup was not available).
5. **Sign the files.** `RetreatPrintAgent.exe` and any installer should be signed with your code-signing certificate, otherwise Windows SmartScreen warns clients.

Uninstall: `uninstall.ps1` in the install folder (or Apps and features). Settings, the ledger and logs in `%LOCALAPPDATA%\RetreatSocialPrint\Agent` are kept unless you pass `-RemoveData`.

## Connect it to an event
1. Admin site: **Event > Printers > Add print computer**. A one-time pairing code (for example `K7M2-P9QX`) appears. It works once and expires after 30 minutes.
2. Agent: **Pair this computer**, enter the platform's address and the code. The agent receives its own credential, stored encrypted with Windows DPAPI (only that Windows user on that computer can read it). The server keeps only a hash.
3. Within seconds the computer shows **online** and lists its printers. Every printer starts **off**.
4. For each printer you want to use, choose the **paper loaded** (4x6, 5x7, 6x8, 2x6 or A5) and turn it **on**. A printer with unknown paper cannot be turned on.
5. In the agent, select the printer and press **Print a test page**: a calibration sheet with a border and four corner marks. All four marks and an even border mean the paper size and margins are right. (This uses one sheet.)

Several computers and several printers per event are supported. A printer only takes jobs made on a frame of its paper size, so a 2x6 strip printer and a 4x6 printer can run side by side. Choosing **Re-pair** (or **Remove**) cuts off the old credential immediately.

## How a job prints
1. The guest finishes; the picture enters the queue (automatic, manual or batch mode decides when it is approved).
2. The agent asks for a job for each enabled printer that Windows reports as ready (not offline, paper out, jammed or paused).
3. It downloads the image and checks its SHA-256 against the server's. A damaged download is never printed.
4. It matches the driver paper size to the event's paper (never "close enough": no match means the job fails with a message listing the sizes the driver offers). It refuses to print if the picture's shape does not match the paper, so nothing is stretched.
5. It prints **one copy at a time**, edge to edge, then waits until Windows has handed the job to the printer. A job stuck on an error (offline, paper out, blocked) is cancelled in Windows and reported as failed, so it cannot print later by surprise.
6. It reports **printed** or **failed** to the server. Operators see this on the print dashboard and can retry.

## Duplicate protection
- The server hands each job to exactly one printer. A job that stays "printing" for 5 minutes without a sign of life goes back to the queue; the agent sends a keep-alive before every copy.
- Before each copy the agent writes to an on-disk ledger, and again after. After a crash or power cut the ledger decides what happened: not started (reported as "nothing printed, press Retry"), in the middle of a copy (reported as "may or may not have printed, check the printer", never as success), or finished (the result is delivered without printing again).
- If the connection drops after printing, the result is saved and delivered first when the connection returns; nothing new is taken on top of an unreported job.
- If the server gives the agent a job it already printed completely, the agent confirms it instead of printing again. If the server gave up and requeued a job the agent actually printed, a late success report is accepted so it is not printed twice.

## Setting up common photo printers
The agent can only use paper sizes the Windows driver exposes. In the printer's Windows driver (Printing preferences):
- **DNP (DS620, DS820, QW410...) and Mitsubishi (CP-D70, D80...)**: choose the 4x6 / 5x7 / 6x8 size you loaded and the **borderless** variant if offered (the agent prefers a borderless size automatically). For 2x6 strips, enable the driver's strip (cut) size. Set the driver's default to the same size.
- **Epson (L8050 and similar)** and **Canon**: choose the 10x15 cm (4x6) or 13x18 cm (5x7) size, set the media type to the photo paper loaded, and enable **borderless**.
- If a size is missing, add a **custom paper size** (Windows: Printer properties, or the driver's own tool) named for example `4x6 borderless` with exact dimensions.
- Keep the driver's own "fit to page" off so nothing is rescaled.

## Command line
`RetreatPrintAgent.exe --help` lists everything. Useful: `--list-printers`, `--selftest --printer "NAME" --paper 4x6` (prints a calibration page with no server), `--server URL --pair CODE --headless` (no window, for a dedicated print PC). `--data-dir` keeps settings elsewhere.

## Logs and troubleshooting
- The window shows connection state, each printer and whether it takes jobs, what is printing, and the latest log lines. **Open log folder** shows the daily files in `%LOCALAPPDATA%\RetreatSocialPrint\Agent\logs` (kept 14 days).
- Offline: the agent retries with growing delays and loses nothing. The operator screen says "print computer is offline".
- "Removed from the event": the computer was removed or re-paired in the admin site; press Pair again.
- "Update required": the server needs a newer agent version.
- "No paper size": the driver has no size matching the event's paper (the message lists what it offers): add a custom size or pick the right paper in the event.

## What has and has not been verified
Verified here: all agent logic with automated tests (47 tests: job handling, per-copy ledger, crash recovery, duplicate protection, checksum check, reporting, paper matching, config encryption, API client); the Windows printing path through the real Windows driver stack to **Microsoft Print to PDF** (correct A5 page, the exact final image embedded at full resolution, edge to edge); printer and paper-size discovery on a computer with real photo printers installed; an end-to-end run (real server, real agent, guest picture to printed result, history recorded); installing from the ZIP, running the installed copy and uninstalling.

**Not verified: printing on a physical photo printer.** No DNP, Mitsubishi, Epson or Canon printer has printed a picture from this software. Before an event, print test pages and a few real pictures on every printer and paper size, and check borderless alignment and colour. Also not verified: a long run with hundreds of jobs, network printers going to sleep mid-event, and the code-signed installer.
