---
title: Privacy Policy for broccoli
---

# Privacy Policy for broccoli

Last updated: 16 November 2026

This policy covers the broccoli extensions for Chrome and Firefox and the backend at `api.anti-brainrot-blocker.fyi`. broccoli checks YouTube videos against your allowed categories and blocks videos that do not match. The developer operates the service and can be contacted at [b.frolikov@gmail.com](mailto:b.frolikov@gmail.com).

## Accounts and information we handle

The developer creates random usernames and passwords and gives them directly to users. Account registration and deletion are handled by the developer rather than through a public registration form.

To provide the service, we handle:

- **Account and authentication information:** your assigned username, password during authentication, internal account ID, authentication tokens, and session records.
- **Category preferences:** the allowed video categories you enter and save.
- **YouTube activity:** the IDs of videos checked when you open YouTube watch pages or Shorts, and whether those videos are allowed. These IDs identify videos you access and are associated with your account during processing, caching, and logging.
- **Video information:** titles, descriptions, channel names, tags, and thumbnail URLs obtained through the YouTube Data API to classify videos.
- **Operational information:** request and error logs, which can include account IDs, video IDs, request paths, timestamps, response status, and other technical request details. The server also processes connection information, including IP addresses, to receive requests and limit abuse.
- **Correspondence:** your email address and information you provide when contacting the developer for support or privacy requests.

## How we use information

We use information to authenticate users, maintain login sessions, save category preferences, classify videos, enforce blocking rules, cache decisions, troubleshoot failures, secure the service, and respond to requests.

We do not sell user data or use it for advertising. Our use and transfer of information received through broccoli complies with the Chrome Web Store User Data Policy, including its Limited Use requirements.

## Storage and security

The extension temporarily stores login drafts, including the password, in browser session storage so that reopening the popup preserves unfinished input. The password draft is cleared after successful login or logout. Access tokens are stored in session storage; refresh tokens are stored in the extension's persistent local storage to maintain login across browser sessions. These stores are not Chrome or Firefox account sync storage.

The backend stores usernames, password hashes, category preferences, and authentication session records in PostgreSQL. Passwords are hashed with bcrypt before database storage. Refresh tokens are stored on the server as hashes rather than as the raw tokens issued to the extension. Per-account video decisions are cached in Redis.

The extensions communicate with the production backend over HTTPS. The backend also uses HTTPS for YouTube and OpenAI API requests.

## Service providers and data sharing

We use the following providers to operate broccoli:

- **DigitalOcean:** hosts the backend and its databases, caches, and operational logs. See [DigitalOcean's privacy policy](https://www.digitalocean.com/legal/privacy-policy).
- **Google / YouTube Data API:** receives video IDs from the backend so it can retrieve video metadata for classification. These requests use the service's API credentials. See [Google's privacy policy](https://policies.google.com/privacy).
- **OpenAI API:** receives the video's title, description, channel name, tags, thumbnail URL when available, and your allowed categories to determine whether a video matches those categories. broccoli does not include your account username, password, account ID, or authentication tokens in these classification requests. Category text is sent as entered, so avoid putting private information in category names. OpenAI's processing of API data is governed by its business agreements and data controls; see [OpenAI's business data privacy information](https://openai.com/business-data/).

These providers process information as needed to deliver their services. Their handling of information is subject to the applicable provider terms and agreements. This policy does not promise a particular provider retention period or data-control setting that has not been verified for this service.

## Retention

- **Account records and categories:** retained while the account remains active, until the developer deletes the account in response to a request.
- **Browser data:** session storage is temporary. The extension removes local authentication tokens on logout. A refresh token can remain in persistent extension storage until logout, removal of the extension, or clearing its data.
- **Authentication sessions:** access tokens expire after 15 minutes. Refresh sessions expire after 30 days without renewal; refreshing extends the session. Logout revokes the refresh session. Expiration or revocation does not itself immediately delete stored session records; expired records are cleaned up when new sessions are created. Account deletion removes associated database session records.
- **Cached video decisions:** expire 1440 hours after being written. A later check can create a new cache entry. Updating your allowed categories clears the existing decision cache for your account.
- **Operational logs:** stored on disk and rotated by size. The deployment configuration retains up to three log files of 10 MB each per service, replacing older files as new logs accumulate. There is no fixed time-based retention period, so logs may remain longer than cached decisions.
- **Database backups:** currently disabled.
- **Support correspondence:** retained as needed to respond to and follow up on your request; no fixed automatic deletion period is configured.

## Your controls and deletion requests

You can change your allowed categories in the extension, sign out, or uninstall it to stop its operation. Uninstalling the extension does not delete your server-side account or data.

To request access to, correction of, or deletion of your account and associated data, email [b.frolikov@gmail.com](mailto:b.frolikov@gmail.com). The developer handles these requests manually and may ask for information needed to verify account ownership. Do not email your password or authentication tokens.

Account deletion removes the account, password hash, saved categories, and associated database authentication sessions. Cached decisions and existing operational logs have separate retention as described above; deleting an account does not automatically erase those logs or the Redis cache. You can ask the developer to address remaining associated data as part of your deletion request. Information already processed by service providers is also subject to their applicable retention and deletion practices.

## Changes to this policy

We will update this page and its last-updated date when our data practices change. Material changes will also be communicated through the extension's listing or directly to users before new processing begins where notice or consent is required.

## Contact

For privacy questions, account registration, or account/data deletion, contact the developer at [b.frolikov@gmail.com](mailto:b.frolikov@gmail.com).
