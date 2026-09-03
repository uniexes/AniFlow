function json(data,status=200){
 return new Response(JSON.stringify(data),{
  status,
  headers:{
   "content-type":"application/json; charset=UTF-8",
   "cache-control":"no-store",
   "access-control-allow-origin":"*"
  }
 });
}

async function proxy(target,init){
 const response=await fetch(target,init);
 const headers=new Headers(response.headers);
 headers.delete("set-cookie");
 headers.set("access-control-allow-origin","*");
 headers.set("cache-control","no-store");
 return new Response(response.body,{
  status:response.status,
  statusText:response.statusText,
  headers
 });
}

function normalizeAniList(items){
 return items.map(x=>({
  mal_id: x.idMal || x.id,
  title: x.title?.romaji || x.title?.english || x.title?.native || "Без названия",
  title_japanese: x.title?.native || null,
  type: x.format || null,
  episodes: x.episodes || null,
  score: x.averageScore ? x.averageScore / 10 : null,
  synopsis: x.description ? x.description.replace(/<[^>]*>/g,"") : "",
  images: {
   jpg: { large_image_url: x.coverImage?.large || x.coverImage?.extraLarge || "" },
   webp: { large_image_url: x.coverImage?.extraLarge || x.coverImage?.large || "" }
  },
  year: x.seasonYear || null
 }));
}

export default {
 async fetch(request,env){
  const url=new URL(request.url);

  if(url.pathname==="/api/search"){
   const q=(url.searchParams.get("q")||"").trim();
   if(q.length<2) return json({data:[]});

   // Primary: Jikan / MyAnimeList data
   try{
    const j=await fetch(
     "https://api.jikan.moe/v4/anime?q="+encodeURIComponent(q)+"&limit=8&sfw=true",
     {headers:{"Accept":"application/json","User-Agent":"AniFlow/1.0"}}
    );
    if(j.ok){
     const data=await j.json();
     if(Array.isArray(data.data) && data.data.length) return json({data:data.data,source:"jikan"});
    }
   }catch(e){}

   // Fallback: AniList, server-side
   try{
    const a=await fetch("https://graphql.anilist.co",{
     method:"POST",
     headers:{
      "Content-Type":"application/json",
      "Accept":"application/json",
      "User-Agent":"AniFlow/1.0"
     },
     body:JSON.stringify({
      query:`query ($search:String){Page(page:1,perPage:8){media(search:$search,type:ANIME,sort:SEARCH_MATCH){id idMal title{romaji english native} format episodes averageScore description coverImage{large extraLarge} seasonYear}}}`,
      variables:{search:q}
     })
    });
    if(a.ok){
     const body=await a.json();
     const items=body?.data?.Page?.media||[];
     return json({data:normalizeAniList(items),source:"anilist"});
    }
   }catch(e){}

   return json({data:[],error:"search_unavailable"},503);
  }

  if(url.pathname==="/api/jikan"){
   const path=url.searchParams.get("path")||"";
   if(!path.startsWith("/v4/")) return json({error:"Invalid Jikan path"},400);
   return proxy(
    "https://api.jikan.moe"+path,
    {method:"GET",headers:{"Accept":"application/json","User-Agent":"AniFlow/1.0"}}
   );
  }

  if(url.pathname==="/api/shikimori"){
   const path=url.searchParams.get("path")||"";
   if(!path.startsWith("/api/")) return json({error:"Invalid Shikimori path"},400);
   return proxy(
    "https://shikimori.one"+path,
    {method:"GET",headers:{"Accept":"application/json","User-Agent":"AniFlow/1.0"}}
   );
  }

  if(url.pathname==="/api/anilist"){
   if(request.method!=="POST") return json({error:"POST required"},405);
   return proxy(
    "https://graphql.anilist.co",
    {
     method:"POST",
     headers:{
      "Content-Type":"application/json",
      "Accept":"application/json",
      "User-Agent":"AniFlow/1.0"
     },
     body:await request.text()
    }
   );
  }

  return env.ASSETS.fetch(request);
 }
};
