// This entrypoint is replaced by scripts/build-vercel.mjs during the build.
export default function handler(_req, res) {
  res.statusCode = 503;
  res.end('API build required');
}
