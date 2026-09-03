# AniFlow
Cloudflare Workers version: static frontend + Worker API proxy.


## v9 search fix
Search now goes through `/api/search` on the Worker. The Worker tries Jikan first and automatically falls back to AniList server-side, so the browser no longer talks to either API directly for search.
