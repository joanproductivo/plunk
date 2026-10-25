/** @type {import('next').NextConfig} */
module.exports = {
  transpilePackages: ['@plunk/ui'],
  // Static export served by nginx in the Docker image; no server is left to optimize images
  output: 'export',
  images: {unoptimized: true},
};
