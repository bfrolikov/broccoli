---
title: Privacy Policy for broccoli
---

# Privacy Policy for broccoli

Last updated 19 November 2026

This policy covers the broccoli extensions for Chrome and Firefox and the backend at `api.anti-brainrot-blocker.fyi`. broccoli checks YouTube videos against your allowed categories and blocks videos that do not match.

## Accounts and information we handle

The developer approves email addresses for registration. Users with an approved address can create an account in the extension. Members sign in with their broccoli account email address or their existing username.

- **Account and authentication information.** We process your email address or username, your password when you register or sign in, your internal account ID, authentication tokens, and session records. If you use email-based password recovery, the backend processes the email address you submit, the six-digit code you enter, and the new password you choose.
- **Category preferences.** We store the allowed video categories you save in the extension.
- **YouTube activity.** When you open a watch page or Short on `www.youtube.com`, the extension reads the video ID from the page URL on your device. If you are signed in, it sends that ID and your broccoli access token to the backend. A check can happen before a video plays. The backend associates the video ID and the decision with your account.
- **Operational information.** Request and error logs can include IP addresses, browser information, request URLs, timestamps, response status, account and video IDs, cached decisions, and delivery IDs for password reset emails. The backend keeps short-lived request counts in memory by IP address and by the identifier you submit for sign-in or recovery. It limits sign-in to five attempts per minute per username or email address, treating different capitalizations of an email address as the same address.
- **Correspondence.** The developer receives your email address and the information you provide when you contact them for support or privacy requests.

## How we use information

We use information to authenticate users, recover access to accounts, save category preferences, check and block videos, cache decisions, troubleshoot failures, secure the service, and respond to requests.

We do not sell user data or use it for advertising. Our use and transfer of information received through the Chrome extension follows the Chrome Web Store User Data Policy, including its [Limited Use requirements](https://developer.chrome.com/docs/webstore/program-policies/limited-use).

## Storage and security

The extension saves the email address or username you enter in temporary browser session storage so it can restore it when you reopen the popup. The popup holds passwords and recovery codes in memory while you use the forms. Signing out clears the saved email address or username.

The extension keeps both access and refresh tokens in temporary browser session storage. They keep you signed in while the browser is open. Signing out or closing the browser clears them. The extension also clears them if the server rejects a refresh token as invalid or expired. When updating from an older version, the extension removes saved password drafts and moves any saved production refresh token into session storage.

The backend stores approved email addresses, account records, saved categories, authentication sessions, and password reset records in PostgreSQL. It stores passwords as bcrypt hashes and refresh tokens as hashes. Each reset record contains your account ID, a keyed hash of the code, its expiry time, and the number of attempts remaining. Redis stores video IDs and decisions by account.

The extensions communicate with the production backend over HTTPS. The backend uses HTTPS to communicate with its API providers.

## Service providers and data sharing

When the backend needs a fresh decision and you have saved allowed categories, it uses YouTube API Services to look up the video and the OpenAI API to classify it.

- **DigitalOcean** hosts the backend, its databases and cache, and its operational logs. [DigitalOcean Privacy Policy](https://www.digitalocean.com/legal/privacy-policy)
- **Google / YouTube Data API** receives the video ID from the backend and returns video metadata. The backend looks up video metadata using broccoli's own API key. [Google Privacy Policy](https://policies.google.com/privacy) · [YouTube Terms of Service](https://www.youtube.com/t/terms)
- **OpenAI API** receives the video's title, description, channel name, tags, and thumbnail URL when available, along with the category text you saved. OpenAI uses these inputs to determine whether the video matches your categories. Keep private information out of your category names. [OpenAI Business Data Privacy](https://openai.com/business-data/)
- **Resend** receives the account email address and the one-time code when broccoli sends a password reset email. It uses them to deliver the email. [Resend Privacy Policy](https://resend.com/legal/privacy-policy)

Each provider handles the information it receives under its applicable terms and data practices.

## Retention

- **Account records and categories.** We keep these until the account is deleted. An approved email address stays on the separate registration list until the developer removes it.
- **Authentication sessions.** Access tokens expire 15 minutes after issuance. Refresh sessions expire 30 days after sign-in, even if the refresh token is renewed. The server cleans up expired records when it creates new sessions. A successful server-side sign-out deletes the corresponding refresh session. A password reset deletes all refresh sessions for the account. Previously issued access tokens can remain valid until they expire.
- **Password reset codes.** A code expires 15 minutes after it is created and can be used once to reset your password. Five incorrect entries disable it sooner, whether you enter them while checking the code or submitting a new password. A successful reset deletes the stored code hash and attempt count. An unused code's record can remain until a replacement is created or the account is deleted.
- **Cached video decisions.** By default, a cached decision expires 60 days after it is written. Saving changes to your allowed categories clears the decision cache for your account. A later check can create a new entry.
- **Operational logs.** The deployment configuration keeps up to three log files of 10 MB each per service and replaces older files as new logs accumulate. Retention depends on log volume, so logs may remain longer than cached decisions.
- **Database backups.** The standard deployment stores the database on persistent disk without scheduled database backups.
- **Support correspondence.** The developer keeps correspondence as needed to respond to and follow up on your request.

## Your controls and deletion requests

You can change your allowed categories in the extension. Sign out or uninstall the extension to stop it from sending video checks. To remove your server-side account or data, send a deletion request to the developer.

The developer handles requests to access, correct, or delete your data manually and may ask for information to verify account ownership. Keep your password, reset codes, and authentication tokens private. Send privacy requests by email to [b.frolikov@gmail.com](mailto:b.frolikov@gmail.com).

Account deletion removes the account, password hash, saved categories, authentication sessions, and password reset records from the database. The registration approval list, cached decisions, and existing logs follow the retention described above. You can ask the developer to remove your approved email address and address any remaining cache or log entries in the same request. Information already sent to service providers is subject to their retention and deletion practices.

## Changes to this policy

We will update this page and its last-updated date when our data practices change. Material changes will also be communicated through the extension's listing or directly to users before new processing begins where notice or consent is required.

## Contact

The developer operates broccoli. For privacy questions, account registration, or deletion requests, contact [b.frolikov@gmail.com](mailto:b.frolikov@gmail.com).
