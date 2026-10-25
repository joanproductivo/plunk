/** @type {import('next-sitemap').IConfig} */
module.exports = {
  siteUrl: process.env.NEXT_PUBLIC_DASHBOARD_URI || 'https://next-app.useplunk.com',
  generateRobotsTxt: true,
  outDir: 'out',
};
