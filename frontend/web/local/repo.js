// Fill in the clone URL from the GitHub Pages address (https://<owner>.github.io/<repo>/).
const host = location.hostname;
if (host.endsWith(".github.io")) {
  const owner = host.split(".")[0];
  const repo = location.pathname.split("/").filter(Boolean)[0] || `${owner}.github.io`;
  const url = `https://github.com/${owner}/${repo}`;
  document.querySelectorAll("[data-repo]").forEach((el) => {
    el.textContent = el.dataset.repo === "clone" ? `git clone ${url}.git\ncd ${repo}` : url;
    if (el.tagName === "A") el.setAttribute("href", url);
  });
}
