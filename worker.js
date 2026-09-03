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

async function fetchWithTimeout(url, options = {}, ms = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      cache: "no-store"
    });
  } finally {
    clearTimeout(timer);
  }
}

function normalizeKitsu(items) {
  return items.map(x => {
    const a = x.attributes || {};
    const poster = a.posterImage || {};

    return {
      mal_id: x.id,
      title:
        a.titles?.en ||
        a.titles?.en_jp ||
        a.titles?.ja_jp ||
        a.canonicalTitle ||
        "Без названия",

      title_japanese: a.titles?.ja_jp || null,
      type: a.subtype || null,
      episodes: a.episodeCount || null,
      score: a.averageRating
        ? Number(a.averageRating) / 10
        : null,

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

      year: a.startDate
        ? Number(String(a.startDate).slice(0, 4)) || null
        : null
    };
  });
}

function normalizeAniList(items) {
  return items.map(x => ({
    mal_id: x.idMal || x.id,

    title:
      x.title?.romaji ||
      x.title?.english ||
      x.title?.native ||
      "Без названия",

    title_japanese: x.title?.native || null,
    type: x.format || null,
    episodes: x.episodes || null,

    score: x.averageScore
      ? x.averageScore / 10
      : null,

    synopsis: x.description
      ? x.description.replace(/<[^>]*>/g, "")
      : "",

    images: {
      jpg: {
        large_image_url:
          x.coverImage?.large ||
          x.coverImage?.extraLarge ||
          ""
      },
      webp: {
        large_image_url:
          x.coverImage?.extraLarge ||
          x.coverImage?.large ||
          ""
      }
    },

    year: x.seasonYear || null
  }));
}

async function searchJikan(q) {
  const response = await fetchWithTimeout(
    "https://api.jikan.moe/v4/anime?q=" +
      encodeURIComponent(q) +
      "&limit=8&sfw=true",
    {
      headers: {
        "Accept": "application/json"
      }
    },
    5000
  );

  if (!response.ok) {
    throw new Error("Jikan HTTP " + response.status);
  }

  const body = await response.json();

  if (!Array.isArray(body.data) || body.data.length === 0) {
    throw new Error("Jikan empty");
  }

  return {
    data: body.data,
    source: "jikan"
  };
}

async function searchKitsu(q) {
  const response = await fetchWithTimeout(
    "https://kitsu.io/api/edge/anime?filter[text]=" +
      encodeURIComponent(q) +
      "&page[limit]=8",
    {
      headers: {
        "Accept": "application/vnd.api+json"
      }
    },
    5000
  );

  if (!response.ok) {
    throw new Error("Kitsu HTTP " + response.status);
  }

  const body = await response.json();

  if (!Array.isArray(body.data) || body.data.length === 0) {
    throw new Error("Kitsu empty");
  }

  return {
    data: normalizeKitsu(body.data),
    source: "kitsu"
  };
}

async function searchAniList(q) {
  const response = await fetchWithTimeout(
    "https://graphql.anilist.co",
    {
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

                title {
                  romaji
                  english
                  native
                }

                format
                episodes
                averageScore
                description

                coverImage {
                  large
                  extraLarge
                }

                seasonYear
              }
            }
          }
        `,

        variables: {
          search: q
        }
      })
    },
    5000
  );

  if (!response.ok) {
    throw new Error(
      "AniList HTTP " + response.status
    );
  }

  const body = await response.json();

  if (body?.errors?.length) {
    throw new Error("AniList GraphQL error");
  }

  const data = normalizeAniList(
    body?.data?.Page?.media || []
  );

  if (!data.length) {
    throw new Error("AniList empty");
  }

  return {
    data,
    source: "anilist"
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    /*
     * ============================
     * ANIME SEARCH
     * ============================
     */

    if (url.pathname === "/api/search") {
      const q = (
        url.searchParams.get("q") || ""
      ).trim();

      if (q.length < 2) {
        return json({
          data: []
        });
      }

      /*
       * Запускаем три источника одновременно.
       *
       * Каждый получает максимум 5 секунд.
       * Первый успешный ответ побеждает.
       *
       * Поэтому даже если Jikan лёг,
       * AniList или Kitsu спасут поиск.
       */

      try {
        const result = await Promise.any([
          searchJikan(q),
          searchKitsu(q),
          searchAniList(q)
        ]);

        return json(result);

      } catch (error) {

        return json(
          {
            data: [],
            error: "search_unavailable",
            message:
              "All anime search providers timed out or failed."
          },
          503
        );
      }
    }

    /*
     * ============================
     * JIKAN PROXY
     * ============================
     */

    if (url.pathname === "/api/jikan") {
      const path =
        url.searchParams.get("path") || "";

      if (!path.startsWith("/v4/")) {
        return json(
          {
            error: "Invalid Jikan path"
          },
          400
        );
      }

      try {
        const response =
          await fetchWithTimeout(
            "https://api.jikan.moe" + path,
            {
              headers: {
                "Accept": "application/json"
              }
            },
            8000
          );

        const headers =
          new Headers(response.headers);

        headers.delete("set-cookie");

        headers.set(
          "access-control-allow-origin",
          "*"
        );

        return new Response(
          response.body,
          {
            status: response.status,
            statusText: response.statusText,
            headers
          }
        );

      } catch (error) {
        return json(
          {
            error: "Jikan unavailable"
          },
          503
        );
      }
    }

    /*
     * ============================
     * SHIKIMORI PROXY
     * ============================
     */

    if (url.pathname === "/api/shikimori") {
      const path =
        url.searchParams.get("path") || "";

      if (!path.startsWith("/api/")) {
        return json(
          {
            error: "Invalid Shikimori path"
          },
          400
        );
      }

      try {
        const response =
          await fetchWithTimeout(
            "https://shikimori.one" + path,
            {
              headers: {
                "Accept": "application/json"
              }
            },
            8000
          );

        const headers =
          new Headers(response.headers);

        headers.delete("set-cookie");

        headers.set(
          "access-control-allow-origin",
          "*"
        );

        return new Response(
          response.body,
          {
            status: response.status,
            statusText: response.statusText,
            headers
          }
        );

      } catch (error) {
        return json(
          {
            error: "Shikimori unavailable"
          },
          503
        );
      }
    }

    /*
     * ============================
     * ANILIST PROXY
     * ============================
     */

    if (url.pathname === "/api/anilist") {

      if (request.method !== "POST") {
        return json(
          {
            error: "POST required"
          },
          405
        );
      }

      try {
        const response =
          await fetchWithTimeout(
            "https://graphql.anilist.co",
            {
              method: "POST",

              headers: {
                "Content-Type":
                  "application/json",

                "Accept":
                  "application/json"
              },

              body: await request.text()
            },
            8000
          );

        const headers =
          new Headers(response.headers);

        headers.delete("set-cookie");

        headers.set(
          "access-control-allow-origin",
          "*"
        );

        return new Response(
          response.body,
          {
            status: response.status,
            statusText: response.statusText,
            headers
          }
        );

      } catch (error) {
        return json(
          {
            error: "AniList unavailable"
          },
          503
        );
      }
    }

    /*
     * ============================
     * STATIC SITE
     * ============================
     */

    return env.ASSETS.fetch(request);
  }
};
