import express from "express";
import fetch from "node-fetch";
import { getYoutubePlaylists } from "./fetch.js";
import { ENV } from "./env.js";

export function setupServer() {
  const app = express();

  app.get("/yt/:id/:playlist", async (req, res) => {
    const { id } = req.params;
    const playlist = req.params.playlist.toLowerCase().split(".")[0];

    console.log("requesting yt video", id);

    if (!["master", "audio", "video"].includes(playlist)) {
      return res.end(404);
    }

    //const baseUrl = req.protocol + "://" + req.get("host");
    const playlists = await getYoutubePlaylists(id, ENV.BASE_URL);
    res.header("content-type", "application/x-mpegURL");
    return res.end(playlists[playlist]);
  });

  // // trying out requesting the manifest from youtube directly instead of building our own
  // app.get("/yt-test/:id/master.m3u8", async (req, res) => {
  //   const { id } = req.params;

  //   console.log("requesting yt manifest for", id);

  //   const manifest = await getYoutubeMasterManifest(id, ENV.BASE_URL);
  //   res.header("content-type", "application/x-mpegURL");
  //   return res.end(manifest);
  // });

  app.get("/proxy", async (req, res) => {
    const url = req.query.url;

    // if (url.endsWith(".m3u8")) {
    //   console.log("proxy requested m3u8, needs rewrite");
    //   const playlist = await fetchAndRewritePlaylist(url, ENV.BASE_URL);
    //   res.header("content-type", "application/x-mpegURL");
    //   return res.end(playlist);
    // }

    // console.log(
    //   "proxying",
    //   url.substring(0, 30) + "..." + url.substring(url.length - 20)
    // );
    const pResp = await fetch(url);
    const buffer = await pResp.buffer();
    res.end(buffer);
  });

  app.listen(9080, "0.0.0.0");
  console.log("server listing");
}
