# darmaaz.github.io

Personal site. Built on [AstroPaper](https://github.com/satnaing/astro-paper).

## Local development

```bash
npm install        # only the first time
npm run dev        # local server at http://localhost:4321
```

## Adding a new post

1. Create a new `.md` (or `.mdx`) file in `src/content/posts/`. The filename becomes the URL slug.
2. Add frontmatter at the top:

   ```yaml
   ---
   title: "Post title"
   description: "One-sentence summary used in cards and og-image."
   pubDatetime: 2026-06-04T00:00:00Z
   featured: false          # set to true to pin to the homepage hero
   tags:
     - tag-one
     - tag-two
   ---
   ```

3. Write the body in markdown below the frontmatter. Code fences, links, images, and most extensions work out of the box.
4. The post appears at `/posts/<filename-without-extension>/` and in the posts archive and tag pages.

## Adding a new project

Edit the `projects` array at the top of `src/pages/projects.astro`. Each entry is a typed object:

```ts
{
  title: "project name",
  summary: "One paragraph. What the project is, what's interesting about it.",
  status: "shipped" | "in-progress" | "archived",
  tags: ["python", "gps"],
  links: [
    { label: "GitHub", href: "https://github.com/darmaaz/..." },
    { label: "Writeup", href: "/posts/<slug>/" },
  ],
}
```

The page renders cards in array order, so put the strongest project first.

## Editing site identity

- **Title, description, author, URL, timezone:** `astro-paper.config.ts` at the project root.
- **Homepage hero copy:** `src/pages/index.astro` (search for the `<section id="hero">` block).
- **About page body:** `src/content/pages/about.md`.
- **Nav menu items:** `src/components/Header.astro` (the `<ul id="menu-items">` block).
- **Social links:** `socials` array in `astro-paper.config.ts`.

## Deploying to GitHub Pages

1. Create a public repo on GitHub named exactly `darmaaz.github.io`.

2. Initialize this directory as a git repo and push:

   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin git@github.com:darmaaz/darmaaz.github.io.git
   git push -u origin main
   ```

3. In the repo's GitHub settings, go to **Pages** → **Build and deployment** → set **Source** to **GitHub Actions**.

4. Add a workflow file at `.github/workflows/deploy.yml`:

   ```yaml
   name: Deploy site
   on:
     push:
       branches: [main]
   permissions:
     contents: read
     pages: write
     id-token: write
   jobs:
     build:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v4
         - uses: actions/setup-node@v4
           with: { node-version: 20 }
         - run: npm ci
         - run: npm run build
         - uses: actions/upload-pages-artifact@v3
           with: { path: ./dist }
     deploy:
       needs: build
       runs-on: ubuntu-latest
       environment:
         name: github-pages
         url: ${{ steps.deploy.outputs.page_url }}
       steps:
         - id: deploy
           uses: actions/deploy-pages@v4
   ```

5. Push that file. The workflow runs on every push to `main`; the site is live at `https://darmaaz.github.io/` within a minute or two.

## Production build (manual check)

```bash
npm run build       # outputs to ./dist
npm run preview     # serves the production build at http://localhost:4321
```

Useful for catching frontmatter-validation or build errors before deploy.

## Notes

- AstroPaper's docs live in the [original repo's README](https://github.com/satnaing/astro-paper) and posts (the four `_*` directories under `src/content/posts/` keep some templates / examples and are skipped by the content loader).
- Search is built locally via [PageFind](https://pagefind.app/) — it runs automatically as part of `npm run build`.
- The `editPost` feature in `astro-paper.config.ts` is currently disabled. Enable it and point the URL at this repo if you want an "edit on GitHub" link on each post.
