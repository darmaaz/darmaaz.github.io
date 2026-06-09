import { defineAstroPaperConfig } from "./src/types/config";

export default defineAstroPaperConfig({
  site: {
    url: "https://darmaaz.github.io/",
    title: "darmaaz",
    description:
      "Notes and projects on trajectory analysis, GPS reconstruction, and adjacent data-engineering work.",
    author: "darmaaz",
    profile: "https://github.com/darmaaz",
    ogImage: "default-og.jpg",
    lang: "en",
    timezone: "America/New_York",
    dir: "ltr",
  },
  posts: {
    perPage: 4,
    perIndex: 4,
    scheduledPostMargin: 15 * 60 * 1000,
  },
  features: {
    lightAndDarkMode: true,
    dynamicOgImage: true,
    showArchives: true,
    showBackButton: true,
    editPost: {
      enabled: false,
    },
    search: "pagefind",
  },
  socials: [
    { name: "github", url: "https://github.com/darmaaz" },
    { name: "mail", url: "mailto:undarmm@gmail.com" },
    // Add when ready:
    // { name: "x",        url: "https://x.com/darmaaz" },
    // { name: "linkedin", url: "https://www.linkedin.com/in/darmaaz/" },
  ],
  shareLinks: [
    { name: "x", url: "https://x.com/intent/post?url=" },
    { name: "mail", url: "mailto:?subject=See%20this%20post&body=" },
  ],
});
