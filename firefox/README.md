# Firefox extension

Requires desktop Firefox 128 or newer. Open `about:debugging#/runtime/this-firefox`,
choose **Load Temporary Add-on**, and select this folder's `manifest.json`.
Temporary installations are removed when Firefox exits. To keep the extension
installed across restarts in standard Firefox, package and sign it through
Mozilla Add-ons (including unlisted distribution). Temporary-loading tests can
instead reload the add-on after restart. No publication has been performed.

Start the backend with all migrations applied and `YOUTUBE_BLOCKER_JWT_SECRET`
configured. Register your account through the private registration listener and
set allowed categories in the popup; accounts with no categories block all videos.

Open the toolbar popup and log in. All requests use
`https://api.anti-brainrot-blocker.fyi`; there is no backend address setting.
The production Caddy overlay provides HTTPS; see the deployment guide for DNS and firewall setup.

On www.youtube.com watch pages and Shorts, the extension hides and pauses the
player until the check succeeds. Blocked results show **Blocked**; errors stay
covered with a Retry button. Open the popup to log in if requested. Checks may
take up to 65 seconds. Navigation triggers a fresh check. Embedded players and
mobile YouTube are unsupported. This is a browser UI filter, not tamper-proof
parental control or a network-level media blocker.

Access JWTs live in memory-backed extension session storage for 15 minutes.
Rotating refresh tokens persist in local extension storage, never sync storage,
and restore login after browser restarts. Local storage is not encrypted at rest.
Login drafts, including passwords, are held only in memory-backed session storage. YouTube/content scripts never receive tokens. Requests
send video IDs to `https://api.anti-brainrot-blocker.fyi`, whose checker may consult
YouTube and OpenAI. Backend permission can be removed through Firefox settings.

Log out while online to revoke the server session. Offline logout clears the local
credentials and reports the failed revocation; it cannot revoke an unreachable
server. An issued access token remains valid for up to 15 minutes after logout.
An interrupted refresh after the server commits rotation may require logging in
again, because the client may not have received the replacement token.

Verification: load the extension, log in, try allowed and blocked videos and
Shorts, navigate quickly between them, use back/forward, stop the backend and
Retry, restart Firefox with a persistently installed extension, and log out.
Check that no video plays before approval, no stale decision
unlocks another video, and credentials never appear in YouTube's DOM or messages.

Run automated extension tests with Node 22+: `node --test tests/extension.test.cjs`.
The tests use isolated browser/storage/network mocks and cover session restoration,
refresh coordination, failure handling, logout, and stale navigation responses.

Common runtime/UI files are generated from `extension/shared`. See
[shared build and test instructions](../README.md) before editing them.

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
