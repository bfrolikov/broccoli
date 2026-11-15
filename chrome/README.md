# Chrome extension

Requires Chrome 120 or newer. Open `chrome://extensions`, enable **Developer mode**,
choose **Load unpacked**, and select this `extension/chrome` folder. Leave the
folder in place; unpacked installations stay installed across browser restarts.
Publishing to the Chrome Web Store is a separate step and has not been performed.

Open the extension's toolbar popup and log in. All requests use
`https://api.anti-brainrot-blocker.fyi`; there is no backend address setting.
Register accounts through the private
registration API and edit allowed categories in the popup.
Accounts with no categories block every video.

Watch pages and Shorts on www.youtube.com remain hidden and paused until the
backend explicitly allows them. Blocked videos show **Blocked**. Errors keep
playback paused and offer Retry. Embedded players and mobile YouTube are unsupported.

Access JWTs remain in session storage; rotating refresh tokens persist in local
storage and restore login after restarting Chrome. Both storage areas are
restricted to trusted extension contexts. Refresh storage is not encrypted by this
extension. Passwords are never saved to disk, and tokens are never sent to YouTube or to
content scripts. Chrome and Firefox have separate sessions.

Chrome uses a service worker that may be suspended when idle. Pending requests
use a bounded heartbeat and a 65-second timeout. If Chrome terminates a request,
the player stays covered and Retry starts a new check. An interrupted refresh
rotation can require logging in again. Logout clears local credentials and tries
to revoke the refresh session; issued JWTs remain valid for up to 15 minutes.

See [shared build and test instructions](../README.md). Edit common code in
`extension/shared`, rather than these generated JavaScript/CSS/popup files.

Saved categories load automatically when you open the popup or log in.
Use the checkbox dropdown to select categories, remove selected tags, or add a
custom name with **Add category**. Adding, removing, or toggling a category saves
your selection automatically. An empty list blocks all videos. Saving updates your account on the
server and rechecks open YouTube tabs. Login fields survive popup closure or
minimization for the current browser session; the password is cleared after a
successful login, explicit logout, or browser restart. Password drafts never enter
local or sync storage. This requires the backend version with GET /categories/.

Upgrading removes old backend settings. Credentials and login drafts saved for
custom servers are cleared, so those users must log in to the production service.
Existing production sessions and login drafts are retained.
