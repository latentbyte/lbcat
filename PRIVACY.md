# LBcat privacy policy

Last updated: 2026-11-11 (version 4.33.1)

LBcat is a browser extension published by Latent Byte LLC. It is a fork of the open source
[ScriptCat](https://github.com/scriptscat/scriptcat) userscript manager with added local browser control for coding
agents. The source code is public at https://github.com/latentbyte/lbcat.

## Summary

- Latent Byte does not collect, store, sell, or share your data. We run no servers that receive data from the extension.
- The extension has no analytics, tracking, or advertising.
- Your scripts, settings, and logs are stored in the browser on your device.

## What the extension accesses, and why

LBcat needs broad access to web pages to do its job. That access is used on your device only.

- **Page content and tabs.** Userscripts you install run on the pages they match. When you connect the optional
  Browser Control tools, a program on your own computer can read and act on tabs in the browser window you designate
  for agents. That traffic goes over a local socket and the browser's Native Messaging channel. It does not go over
  the network.
- **Cookies and web requests.** Used only to provide the userscript APIs (`GM_cookie`, `GM_xmlhttpRequest`) to scripts
  that you installed and approved.
- **Downloads, clipboard, notifications.** Used only when a script you installed, or a command you ran, asks for them.

## Data that leaves your device

The extension sends data over the network only in these cases:

- **Scripts you install** can make network requests to the sites they declare. You see and approve those permissions
  when installing a script. Scripts are third-party code; review them before installing.
- **Script and subscription updates.** The extension checks the update URL of each installed script.
- **ScriptCat services.** LBcat does not contact ScriptCat's servers on its own: the upstream version check and
  site icon service are removed. Two things still reach servers run by the ScriptCat project, not by Latent Byte,
  and only when you use them: the sign-in relay for connecting a cloud drive (OneDrive and similar) to sync, which
  LBcat keeps because those sign-ins do not work without it, and links you open to the ScriptCat script store and
  documentation.
- **Site icons.** Icons in the script list are fetched from the sites your scripts match. If you pick Google,
  DuckDuckGo, or Icon Horse as the icon service in settings, the matched domain names go to that service instead.
- **Cloud sync and backup**, if you turn it on, sends your scripts to the storage provider you configure (for example
  WebDAV or a cloud drive) using credentials you supply.
- **The built-in AI agent**, if you configure it, sends your prompts and the page content it works on to the model
  provider you chose, using your own API key. Nothing is sent until you add a provider.

## Local Browser Control

The companion command line tools (`browser-control`, its daemon, and the native messaging host) run on your computer
and are installed separately. They accept commands only from local programs under your user account. Commands are
limited to the agent window you designate; a tab outside it is reachable only when you grant that exact tab.
Screenshots and page content requested through these tools are returned to the local program that asked for them.

## Retention and deletion

All extension data lives in your browser profile. Removing the extension deletes it. Data you sent to a sync provider
or model provider is governed by that provider's policy.

## Changes

Changes to this policy are published in this file, with the date above updated.

## Contact

Open an issue at https://github.com/latentbyte/lbcat/issues.
