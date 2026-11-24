# Offline event mode (local venue server)

For venues where the internet cannot be trusted. A **local server** runs the same software on a laptop or mini PC at the venue. Guests connect to it over the venue's own Wi-Fi, printing and the photo wall run from it, and everything that happens is **delivered to the cloud** whenever a connection is available.

```
Guests' phones --Wi-Fi--> LOCAL SERVER --(when internet allows)--> CLOUD
Print computer ---------> LOCAL SERVER            (event package comes down, guest data goes up)
```

Two operating modes of the same code, chosen by `RSP_MODE`:

| | cloud (default) | local |
|---|---|---|
| Who uses it | everyone, normal operation | one venue, one event (or a few) |
| Database / files | its own | its own (separate from the cloud) |
| Delivers data upward | no | yes, automatically |
| Accepts sync pushes / makes event packages | yes | no |
| Installs event packages | never (refused) | yes, super administrator only |

## What works without the cloud
Guest site, photo upload, frame choice, server-side composition, the single final image, download, QR codes, the staff photo gallery and moderation, the operator print dashboard and print queue (with the Windows print agent paired to the **local** server), the photo wall, the mosaic, sponsors.

## What does not
- **Sharing to Instagram / WhatsApp** needs the guest's own phone to have internet. Venue Wi-Fi without internet cannot do it; the guest screen says so and offers Download.
- **Cloud-side analytics and reports** see the event only after delivery.
- **Anything done in the cloud after the package was installed** (for example a new frame) reaches the venue only when the package is downloaded and installed again. There is no live downward sync.
- **The guest's browser going offline** (a phone leaving Wi-Fi mid-upload) is not handled by a service worker; the guest retries.

## Setting it up
1. **Cloud:** build the event completely (guest page published, frames, sponsors, QR codes, branding, wall/mosaic settings). Open *Event > Offline mode*.
2. **Download the event package** (step 1 on that page). It holds the event's configuration and image files. It contains **no guest data, no staff accounts and no printers**. All identifiers, guest links and QR codes are preserved.
3. **Create a sync credential** (step 2). It is shown once. It allows one thing: delivering this event's data. Only a hash is stored in the cloud; revoke it any time.
4. **Install the software** on the venue machine (Node 22+, PostgreSQL 16+, `pnpm install`, same release as the cloud: the cloud refuses a delivery from a different version). Start the API with:
   ```
   RSP_MODE=local
   DATABASE_URL=postgres://...local database...
   STORAGE_DIR=D:\rsp-storage
   SESSION_SECRET=<a long random value>
   CLOUD_URL=https://your-cloud.example.com
   SYNC_TOKENS=sync_...            # comma-separated for several events
   SYNC_INTERVAL_SECONDS=20        # optional
   ```
   Create the local administrator with the seed-admin command, then run the web app as usual.
5. **Install the package** on the local server: *Event > Offline mode > Install or refresh an event package* (super administrator). Installing again refreshes the configuration and never touches guests already there or a local pause.
6. **QR codes:** open the local server's admin address (the venue-network address), then print or display the QR codes **from there**, so they point at the local server. Guest links keep their token, only the address in front changes.
7. **Printing:** pair the Windows print agent with the **local** server's address (see `docs/PRINT_AGENT.md`).
8. **Check:** the status bar at the top of every admin page and of the operator dashboard shows *cloud connected* or *cloud not reachable* and how many items wait to be delivered.

### Network notes
- A router with Wi-Fi and a fixed address for the server (for example `http://192.168.1.10:3100`) is enough. Guests need that address through the QR code.
- **HTTPS:** browsers only allow the live camera (`getUserMedia`) on secure pages. Over plain `http://` on the venue network the guest can still pick or take a photo through the phone's normal file picker, but the in-page webcam capture will not start. For kiosks that need the webcam, give the local server a certificate (a local DNS name with a locally trusted certificate) or use the kiosk browser's secure-origin allowance.
- Use a UPS and set the machine not to sleep. Back up the local database and storage folder.

## What is delivered, and how
Every 20 seconds (and on **Deliver now**) the local server compares its data with what it last delivered and sends only the difference, in batches, **files first, then the rows that use them**:

guest sessions, original photos, final pictures, which photo is in which slot, print jobs and their status history, share attempts, QR scans, wall appearance counts.

- **Idempotent.** Everything has a permanent identifier; the cloud ignores what it already has. A crash, a dropped connection or a repeated delivery never duplicates or loses anything. Numbered history rows are matched by their origin, and QR scans are added to the code's total only once.
- **Changes travel.** Moderating a picture, a print status change, a hidden picture: the changed row is sent again.
- **Deletions travel, including the files.** Deleting a picture or a guest's data on the local server removes it, its files and its cached copies from the cloud on the next delivery. This is deliberate: privacy deletions must not be undone by synchronisation.
- **Local is the authority for what happened locally.** A change made in the cloud to a locally created picture is overwritten the next time that row changes locally. Edits flow cloud to local only through the event package.
- **Printing is never repeated.** A print job delivered to the cloud is a **read-only record** there: it cannot be claimed by a cloud print agent, requeued, approved, retried or cancelled. This prevents a picture that already printed at the venue from printing again from the cloud.
- **Local-only references are cleared in the cloud:** the local server's staff accounts, printers and devices do not exist there, so those columns are emptied.
- **Same release required.** If versions differ, nothing is delivered and the status says so.
- **Security.** A sync credential reaches one event only; rows or files of another event are refused whole; only the listed tables and the picture folders of that event are accepted; file names are restricted; every upload is checked against its SHA-256; every delivery is rate limited and audited.

## Troubleshooting
| Status bar says | Meaning |
|---|---|
| not connected to the cloud | `CLOUD_URL` / `SYNC_TOKENS` are not set |
| cloud not reachable | no internet, or the cloud/proxy answered 502/503/504. Nothing is lost; the count shows the backlog |
| cloud refused (`invalid_credential`) | the credential was revoked; create a new one and update `SYNC_TOKENS` |
| cloud refused (`version_mismatch`) | local and cloud run different releases |
| cloud refused (`conflict`) | a record clashes with one already in the cloud (for example the same guest ID from a guest who used the cloud site before the event) |
| *N file(s) missing on this server were held back* | a picture row points at a file that is not in the local storage folder; restore it from backup |

## Verified and not verified
Verified by automated tests with a real cloud server and a real local server (separate databases and storage folders, real HTTP between them), and by a browser run of the same pair: package export and install with checks against damaged or hostile packages; local guests, composition and print queue without the cloud; delivery of every table with files byte for byte; idempotence including after losing the sync memory; moderation and deletion propagation; a cloud that goes down and comes back (also behind a proxy); an interrupted delivery; revoked and replaced credentials; cross-event and hostile-input refusal; read-only delivered print jobs.

**Not verified:** a real venue network, a real internet outage, real phones on venue Wi-Fi, the webcam over a local certificate, a real print agent talking to a local server, large events (tens of thousands of pictures: each delivery round re-reads the event's rows), a very slow or metered connection, and running the local server on hardware other than this development PC.

**Not built:** live downward synchronisation of changes made in the cloud during the event, running several local servers for the same event at once, resolving conflicts when the same guest used both servers, a client-side (service worker) offline queue in the guest's browser, delivering the mosaic's and wall's derived data (it is recomputed in the cloud from the pictures), delivering staff audit logs.
