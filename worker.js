function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=UTF-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*"
    }
  });
}

async function proxy(target, init) {
  const response = await fetch(target, init);
  const headers = new Headers(response.headers);
  headers.delete("set-cookie");
  headers.set("access-control-allow-origin", "*");
  headers.set("cache-control", "no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function normalizeAniList(items) {
  return items.map(x => ({
    mal_id: x.idMal || x.id,
    title: x.title?.romaji || x.title?.english || x.title?.native || "Без названия",
    title_japanese: x.title?.native || null,
    type: x.format || null,
    episodes: x.episodes || null,
    score: x.averageScore ? x.averageScore / 10 : null,
    synopsis: x.description ? x.description.replace(/<[^>]*>/g, "") : "",
    images: {
      jpg: { large_image_url: x.coverImage?.large || x.coverImage?.extraLarge || "" },
      webp: { large_image_url: x.coverImage?.extraLarge || x.coverImage?.large || "" }
    },
    year: x.seasonYear || null
  }));
}

function normalizeKitsu(items) {
  return items.map(x => {
    const a = x.attributes || {};
    const poster = a.posterImage || {};
    const title =
      a.titles?.en ||
      a.titles?.en_jp ||
      a.titles?.ja_jp ||
      a.canonicalTitle ||
      "Без названия";

    return {
      mal_id: x.id,
      title,
      title_japanese: a.titles?.ja_jp || null,
      type: a.subtype || null,
      episodes: a.episodeCount || null,
      score: a.averageRating ? Number(a.averageRating) / 10 : null,
      synopsis: a.synopsis || "",
      images: {
        jpg: {
          large_image_url:
            poster.large ||
            poster.medium ||
            poster.original ||
            poster.small ||
            ""
        },
        webp: {
          large_image_url:
            poster.original ||
            poster.large ||
            poster.medium ||
            ""
        }
      },
      year: a.startDate ? Number(String(a.startDate).slice(0, 4)) || null : null
    };
  });
}

async function searchJikan(q) {
  const r = await fetch(
    "https://api.jikan.moe/v4/anime?q=" +
      encodeURIComponent(q) +
      "&limit=8&sfw=true",
    {
      headers: { "Accept": "application/json" },
      cf: { cacheTtl: 0, cacheEverything: false }
    }
  );

  if (!r.ok) throw new Error("Jikan HTTP " + r.status);

  const body = await r.json();
  if (!Array.isArray(body.data)) throw new Error("Jikan invalid response");
  return body.data;
}

async function searchKitsu(q) {
  const url =
    "https://kitsu.io/api/edge/anime?filter[text]=" +
    encodeURIComponent(q) +
    "&page[limit]=8";

  const r = await fetch(url, {
    headers: {
      "Accept": "application/vnd.api+json",
      "Content-Type": "application/vnd.api+json"
    },
    cf: { cacheTtl: 0, cacheEverything: false }
  });

  if (!r.ok) throw new Error("Kitsu HTTP " + r.status);

  const body = await r.json();
  if (!Array.isArray(body.data)) throw new Error("Kitsu invalid response");
  return normalizeKitsu(body.data);
}

async function searchAniList(q) {
  const r = await fetch("https://graphql.anilist.co", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json"
    },
    body: JSON.stringify({
      query: `
        query ($search: String) {
          Page(page: 1, perPage: 8) {
            media(
              search: $search
              type: ANIME
              sort: SEARCH_MATCH
            ) {
              id
              idMal
              title { romaji english native }
              format
              episodes
              averageScore
              description
              coverImage { large extraLarge }
              seasonYear
            }
          }
        }
      `,
      variables: { search: q }
    })
  });

  if (!r.ok) throw new Error("AniList HTTP " + r.status);

  const body = await r.json();
  if (body?.errors?.length) {
    throw new Error("AniList GraphQL error");
  }

  return normalizeAniList(body?.data?.Page?.media || []);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/search") {
      const q = (url.searchParams.get("q") || "").trim();

      if (q.length < 2) {
        return json({ data: [] });
      }

      // 1. MAL/Jikan
      try {
        const data = await searchJikan(q);
        if (data.length) {
          return json({ data, source: "jikan" });
        }
      } catch (e) {
        // Continue to the next provider.
      }

      // 2. Kitsu — independent fallback.
      try {
        const data = await searchKitsu(q);
        if (data.length) {
          return json({ data, source: "kitsu" });
        }
      } catch (e) {
        // Continue to the next provider.
      }

      // 3. AniList — second independent fallback.
      try {
        const data = await searchAniList(q);
        if (data.length) {
          return json({ data, source: "anilist" });
        }
      } catch (e) {
        // Continue to diagnostics.
      }

      return json({
        data: [],
        error: "search_unavailable",
        message: "All anime search providers failed."
      }, 503);
    }

    if (url.pathname === "/api/jikan") {
      const path = url.searchParams.get("path") || "";
      if (!path.startsWith("/v4/")) {
        return json({ error: "Invalid Jikan path" }, 400);
      }

      return proxy(
        "https://api.jikan.moe" + path,
        {
          method: "GET",
          headers: { "Accept": "application/json" }
        }
      );
    }

    if (url.pathname === "/api/shikimori") {
      const path = url.searchParams.get("path") || "";
      if (!path.startsWith("/api/")) {
        return json({ error: "Invalid Shikimori path" }, 400);
      }

      return proxy(
        "https://shikimori.one" + path,
        {
          method: "GET",
          headers: { "Accept": "application/json" }
        }
      );
    }

    if (url.pathname === "/api/anilist") {
      if (request.method !== "POST") {
        return json({ error: "POST required" }, 405);
      }

      return proxy(
        "https://graphql.anilist.co",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Accept": "application/json"
          },
          body: await request.text()
        }
      );
    }

    return env.ASSETS.fetch(request);
  }
};
