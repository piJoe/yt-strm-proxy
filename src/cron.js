import util from "node:util";
import fs from "fs";
import path from "path";
import fetch from "node-fetch";
import { exec } from "node:child_process";
import sanitize from "sanitize-filename";
import { fetchYoutubeData } from "./fetch.js";
import { schedule } from "node-cron";
import { ENV } from "./env.js";
import sharp from "sharp";

const exec_p = util.promisify(exec);

/**
 * - regulary fetch playlist/channels/whatever
 * - download metadata of any new videos
 * - generate .strm files containing links to respective master.m3u8
 * - also .nfo files along with any useful metadata
 * - place .strm + .nfo into the corresponding folder in jellfin/kodi-nfs?
 */

async function getYtPlaylist(url, options = { afterTimespan: false }) {
  try {
    let playlistData = null;

    if (options.afterTimespan) {
      // if afterTimestamp is set, we need to iterate the playlist in multiple smaller steps, breaking on first timestamp that is smaller than `afterTimestamp`.
      const afterTimestamp =
        Math.floor(Date.now() / 1000) - options.afterTimespan;

      console.log(
        "afterTimespan setting found, requesting playlist in smaller steps until",
        afterTimestamp
      );

      let i = 0;
      while (true) {
        console.log(`get playlist in parts [${i}-${i + 10}]`, url);
        const { stdout } = await exec_p(
          `${
            ENV.YTDLP_BINARY
          } --flat-playlist --extractor-args "youtubetab:approximate_date" -I ${i}:${
            i + 10
          } -J ${url}`,
          { maxBuffer: 1024 * 1024 * 1024 }
        );
        if (!stdout) {
          return null;
        }

        const partialPlaylistData = JSON.parse(stdout);

        if (playlistData === null) {
          playlistData = { ...partialPlaylistData, entries: [] };
        }

        playlistData.entries.push(
          ...partialPlaylistData.entries.filter(
            (e) => e.timestamp >= afterTimestamp
          )
        );

        const hasOlderThanTimestampVideos = partialPlaylistData.entries.some(
          (e) => e.timestamp < afterTimestamp
        );

        if (
          hasOlderThanTimestampVideos ||
          partialPlaylistData.entries.length < 1
        ) {
          break;
        }

        i += 10;
      }
    } else {
      // otherwise (no afterTimestamp set) fetch the whole playlist at once
      const { stdout } = await exec_p(
        `${ENV.YTDLP_BINARY} --flat-playlist --extractor-args "youtubetab:approximate_date" -J ${url}`,
        { maxBuffer: 1024 * 1024 * 1024 }
      );
      if (!stdout) {
        return null;
      }

      playlistData = JSON.parse(stdout);
    }

    // filter out any videos that cannot be further processed right now (might change in the future)
    playlistData.entries = playlistData.entries.filter((e) => {
      const cannotBeProcessed = [
        "is_live",
        "is_upcoming",
        "post_live",
      ].includes(e.live_status);

      if (cannotBeProcessed) {
        console.log(
          "Entry cannot be processed because live_status is",
          e.live_status
        );
        return false;
      }
      return true;
    });

    return {
      listId: playlistData.id,
      title: playlistData.title,
      entries: playlistData.entries,
      metadata: {
        title: playlistData.title,
        description: playlistData.description,
        thumb: playlistData.thumbnails[playlistData.thumbnails.length - 1].url,
      },
    };
  } catch (e) {
    console.error(e);
    return null;
  }
}

async function updatePlaylistFolder(
  playlistUrl,
  dirPath,
  options = {
    orderByTimestamp: false,
    customSeasonNumber: 1,
    playlistMetaOverride: {},
    afterTimespan: false,
  }
) {
  const res = await getYtPlaylist(playlistUrl, {
    afterTimespan: options.afterTimespan,
  });
  const listId = res.listId;

  res.metadata = { ...res.metadata, ...options.playlistMetaOverride };

  const playlistFolderPath = path.join("/shows", dirPath);
  fs.mkdirSync(playlistFolderPath, { recursive: true });

  const existingFiles = fs.readdirSync(playlistFolderPath);

  const videosToAdd = res.entries
    .map((e, i) => {
      return { id: e.id, episodeNumber: i + 1 };
    })
    .filter(
      ({ id }) => existingFiles.findIndex((p) => p.includes(`yt-${id}`)) < 0
    );

  if (videosToAdd.length < 1) {
    console.log("no new videos found, we're done here.");
    return;
  }

  // write tvshow.nfo for this playlist
  if (existingFiles.findIndex((p) => p.includes("tvhshow.nfo")) < 0) {
    fs.writeFileSync(
      path.join(playlistFolderPath, `tvshow.nfo`),
      generatePlaylistNfo(listId, res.metadata)
    );
    // fetch thumbnail for playlist as well
    await downloadThumbnail(
      res.metadata.thumb,
      path.join(playlistFolderPath, `poster.jpg`)
    );
  }

  for (const entry of videosToAdd) {
    console.log("new video", entry.id);
    const data = await fetchYoutubeData(entry.id);

    const sanitizedTitle = sanitize(data.metadata.title)
      .replaceAll(/[\,\.\'\"\-]/g, "")
      .split(" ")
      .join(".")
      .replaceAll(/\.+/g, ".");

    let filename = `E${String(entry.episodeNumber).padStart(
      4,
      "0"
    )}.${sanitizedTitle}.yt-${entry.id}`;

    // when ordering by timestamp, we do not want E0001 in our filename, rather we need the timestamp
    if (options.orderByTimestamp) {
      filename = `${data.metadata.timestamp}.${sanitizedTitle}.yt-${entry.id}`;
    }

    console.log("writing .strm and .nfo files at", filename);

    fs.writeFileSync(
      path.join(playlistFolderPath, `${filename}.strm`),
      generateStrmContents(data)
    );
    fs.writeFileSync(
      path.join(playlistFolderPath, `${filename}.nfo`),
      metadata2nfo({
        ...data.metadata,
        ytId: entry.id,
        episodeNumber: entry.episodeNumber,
        seasonNumber: options.customSeasonNumber ?? "1",
        orderByTimestamp: options.orderByTimestamp,
      })
    );

    // fetch thumbnail, save as ${filename}-thumb.jpg
    await downloadThumbnail(
      data.metadata.thumb,
      path.join(playlistFolderPath, `${filename}-thumb.jpg`)
    );
  }
}

function generateStrmContents(youtubeData) {
  return `${ENV.BASE_URL}${youtubeData.baseUrlPath}/master.m3u8`;
}

function metadata2nfo(metadata) {
  const timestamp = new Date(metadata.timestamp * 1000)
    .toISOString()
    .split("T")[0];
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<episodedetails>
    <title>${escapeXml(metadata.title)}</title>
    <plot>${escapeXml(metadata.description)}</plot>
    <uniqueid type="yt" default="true">${metadata.ytId}</uniqueid>
    ${
      // only when we do not order by timestamp we want the episode numberings etc.
      metadata.orderByTimestamp
        ? ""
        : `<season>${metadata.seasonNumber ?? "1"}</season>
    <episode>${metadata.episodeNumber}</episode>
    <displayseason>-1</displayseason>
    <displayepisode>-1</displayepisode>`
    }
    <aired>${timestamp}</aired>
    <premiered>${timestamp}</premiered>
    <runtime>${(metadata.duration / 60).toFixed(2)}</runtime>
</episodedetails>`;
}

function generatePlaylistNfo(listId, meta) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<tvshow>
    <title>${escapeXml(meta.title)}</title>
    <plot>${escapeXml(meta.description)}</plot>
    <uniqueid type="yt-playlist" default="true">${listId}</uniqueid>
    <displayseason>-1</displayseason>
    <displayepisode>-1</displayepisode>
</tvshow>`;
}

function escapeXml(unsafe) {
  return unsafe.replace(/[<>&'"]/g, function (c) {
    switch (c) {
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "&":
        return "&amp;";
      case "'":
        return "&apos;";
      case '"':
        return "&quot;";
    }
  });
}

async function downloadThumbnail(url, targetPath) {
  // fetch thumbnail
  const thumbB = await (await fetch(url)).buffer();
  await sharp(thumbB).toFile(targetPath);
}

function setupIndividualCronjobs(cronJson) {
  cronJson.forEach(async (entry) => {
    console.log("setting up cron for", entry.url, "schedule", entry.schedule);
    schedule(entry.schedule, async () => {
      console.log("running cron for", entry.url);
      await updatePlaylistFolder(entry.url, entry.dir, entry.options);
    });
  });
}

async function runGrabberCron() {
  const crons = JSON.parse(fs.readFileSync("/config/cron.json"));
  for (const entry of crons) {
    console.log("running cron for", entry.url);
    await updatePlaylistFolder(entry.url, entry.dir, entry.options);
  }
}

export function setupSingleCron() {
  if (ENV.RUN_CRON_AT_START) {
    console.log("executing cron at run");
    runGrabberCron();
  }

  console.log("setting up cron to check for new videos");
  schedule(ENV.CRON_SCHEDULE, async () => {
    await runGrabberCron();
  });
}

/**
 * common afterTimespans:
 * - 604800 (7 days)
 * - 1209600 (14 days)
 * - 2592000 (30 days / 1 month)
 * - 5184000 (60 days / 2 monts)
 */
