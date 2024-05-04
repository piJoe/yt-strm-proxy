export const ENV = {
  BASE_URL: process.env.BASE_URL ?? "http://192.168.88.254:9080",
  CRON_SCHEDULE: process.env.CRON_SCHEDULE ?? "5 */2 * * *",
  RUN_CRON_AT_START: process.env.RUN_CRON_AT_START === "true",
  YTDLP_BINARY: "/home/node/app/bin/yt-dlp_linux",
};
