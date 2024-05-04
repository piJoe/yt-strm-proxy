import util from "node:util";
import fetch from "node-fetch";
import { exec } from "node:child_process";
import { ENV } from "./env.js";

const exec_p = util.promisify(exec);

const CACHE_DURATION = 60 * 60 * 1000; // 60 minutes

const cachedResponses = new Map();

export async function fetchYoutubeData(id) {
  try {
    // first, cleanup cache before accessing it
    cleanupCache();

    // now see if we (still) have results in cache
    if (cachedResponses.has(id)) {
      console.log("cache hit for", id);
      const cachedData = cachedResponses.get(id);
      console.log("answer from cache");
      return cachedData;
    }

    // if not in cache, re-request data via yt-dlp
    console.log("freshly requesting", id);

    const { stdout, stderr } = await exec_p(`${ENV.YTDLP_BINARY} -j ${id}`);
    if (!stdout) {
      return null;
    }

    const data = JSON.parse(stdout);

    if (!data.formats) {
      return null;
    }

    const metadata = {
      title: data.fulltitle ?? "",
      description: data.description ?? "",
      timestamp:
        data.timestamp ?? data.release_timestamp ?? parseYMD(data.upload_date),
      thumb: data.thumbnail ?? null,
      tags: data.tags ?? [],
      duration: data.duration,
    };

    const playlistFormats = data.formats.filter(
      (f) => f.protocol.includes("m3u8") // f.protocol === "m3u8_native"
    );

    const audioFormats = playlistFormats.filter(
      (f) => f.resolution === "audio only"
    );

    const videoFormats = playlistFormats.filter(
      (f) => f.resolution !== "audio only"
    );

    const bestFormats = {
      audio: audioFormats[0],
      video: videoFormats.sort((a, b) => b.quality - a.quality)[0],
    };

    const response = {
      baseUrlPath: `/yt/${id}`,
      metadata,
      formats: bestFormats,
      playlists: {
        audio: await (await fetch(bestFormats.audio.url)).text(),
        video: await (await fetch(bestFormats.video.url)).text(),
      },
      cacheUntil: Date.now() + CACHE_DURATION,
    };
    cachedResponses.set(id, response);

    return response;
  } catch (e) {
    console.error(e);
    return null;
  }
}

function parseYMD(s) {
  let [C, Y, M, D] = s.match(/\d\d/g);
  return Math.floor(new Date(C + Y, M - 1, D) / 1000);
}

async function generatePlaylists(id, baseUrlRewrite) {
  try {
    const data = await fetchYoutubeData(id);
    const masterPlaylist = `#EXTM3U
#EXT-X-VERSION:4
#EXT-X-MEDIA:TYPE=AUDIO,URI="${baseUrlRewrite}/yt/${id}/audio.m3u8",GROUP-ID="default-audio-group",NAME="${
      data.formats.audio.format_note ?? "audio"
    }",AUTOSELECT=YES,DEFAULT=YES

#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=2000000,AUDIO="default-audio-group"
${baseUrlRewrite}/yt/${id}/video.m3u8`;

    const audioPlaylist = rewritePlaylist(data.playlists.audio, baseUrlRewrite);
    const videoPlaylist = rewritePlaylist(data.playlists.video, baseUrlRewrite);

    return {
      master: masterPlaylist,
      audio: audioPlaylist,
      video: videoPlaylist,
    };
  } catch (e) {
    console.error(e);
    return null;
  }
}

export async function getYoutubePlaylists(id, baseUrlRewrite) {
  return await generatePlaylists(id, baseUrlRewrite);
}

// cleanup cache, remove any expired entry
function cleanupCache() {
  for (const [id, data] of cachedResponses) {
    if (data.cacheUntil <= Date.now()) {
      cachedResponses.delete(id);
    }
  }
}

function rewritePlaylist(playlist, baseUrlRewrite) {
  const lines = playlist.split("\n");

  let newPlaylist = [];
  for (const line of lines) {
    if (line.startsWith('#EXT-X-MAP:URI="https://')) {
      newPlaylist.push(
        `#EXT-X-MAP:URI="${baseUrlRewrite}/proxy/?url=${encodeURIComponent(
          line.substring(16, line.length - 1)
        )}"`
      );
    } else if (line.startsWith("https://")) {
      newPlaylist.push(
        `${baseUrlRewrite}/proxy/?url=${encodeURIComponent(line)}`
      );
    } else {
      newPlaylist.push(line);
    }
  }

  return newPlaylist.join("\n");
}
