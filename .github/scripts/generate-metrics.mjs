import fs from "node:fs/promises";

const TOKEN = process.env.GH_TOKEN;
const EXPECTED_USERNAME = process.env.GH_USERNAME;

if (!TOKEN) {
  throw new Error("GH_TOKEN is missing");
}

if (!EXPECTED_USERNAME) {
  throw new Error("GH_USERNAME is missing");
}

const API_HEADERS = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "github-profile-metrics",
};

async function githubApi(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...API_HEADERS,
      ...options.headers,
    },
  });

  if (!response.ok) {
    const body = await response.text();

    throw new Error(
      `GitHub API ${response.status}: ${body.slice(0, 500)}`
    );
  }

  return response.json();
}

async function graphql(query, variables = {}) {
  const result = await githubApi("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query,
      variables,
    }),
  });

  if (result.errors?.length) {
    throw new Error(
      `GitHub GraphQL: ${JSON.stringify(result.errors)}`
    );
  }

  return result.data;
}

async function getAuthenticatedUser() {
  return githubApi("https://api.github.com/user");
}

async function getAllRepositories() {
  const repositories = [];

  for (let page = 1; ; page += 1) {
    const url =
      "https://api.github.com/user/repos" +
      "?visibility=all" +
      "&affiliation=owner,collaborator,organization_member" +
      "&sort=full_name" +
      "&direction=asc" +
      "&per_page=100" +
      `&page=${page}`;

    const batch = await githubApi(url);

    repositories.push(...batch);

    if (batch.length < 100) {
      break;
    }
  }

  return repositories;
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  async function runner() {
    while (true) {
      const index = cursor++;

      if (index >= items.length) {
        return;
      }

      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, items.length) },
      () => runner()
    )
  );

  return results;
}

async function getLanguageTotals(repositories) {
  const totals = new Map();

  const languageResults = await mapWithConcurrency(
    repositories,
    6,
    async (repository) => {
      try {
        return await githubApi(repository.languages_url);
      } catch (error) {
        console.warn(
          `Language scan skipped for one repository: ${error.message}`
        );

        return {};
      }
    }
  );

  for (const languages of languageResults) {
    for (const [language, bytes] of Object.entries(languages)) {
      totals.set(
        language,
        (totals.get(language) ?? 0) + Number(bytes)
      );
    }
  }

  return [...totals.entries()]
    .map(([language, bytes]) => ({
      language,
      bytes,
    }))
    .sort((a, b) => b.bytes - a.bytes);
}

async function getContributionStats(createdAt) {
  const createdYear = new Date(createdAt).getUTCFullYear();
  const currentYear = new Date().getUTCFullYear();

  const totals = {
    contributions: 0,
    commits: 0,
    pullRequests: 0,
    issues: 0,
    reviews: 0,
  };

  const query = `
    query ContributionStats($from: DateTime!, $to: DateTime!) {
      viewer {
        contributionsCollection(from: $from, to: $to) {
          contributionCalendar {
            totalContributions
          }

          totalCommitContributions
          totalPullRequestContributions
          totalIssueContributions
          totalPullRequestReviewContributions
        }
      }
    }
  `;

  for (let year = createdYear; year <= currentYear; year += 1) {
    const from = `${year}-01-01T00:00:00Z`;

    const to =
      year === currentYear
        ? new Date().toISOString()
        : `${year}-12-31T23:59:59Z`;

    const data = await graphql(query, {
      from,
      to,
    });

    const collection =
      data.viewer.contributionsCollection;

    totals.contributions +=
      collection.contributionCalendar.totalContributions;

    totals.commits +=
      collection.totalCommitContributions;

    totals.pullRequests +=
      collection.totalPullRequestContributions;

    totals.issues +=
      collection.totalIssueContributions;

    totals.reviews +=
      collection.totalPullRequestReviewContributions;
  }

  return totals;
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function number(value) {
  return new Intl.NumberFormat("en-US").format(value);
}

function createStatsSvg({
  username,
  repositories,
  contributions,
}) {
  const publicRepos = repositories.filter(
    (repo) => !repo.private
  ).length;

  const privateRepos = repositories.filter(
    (repo) => repo.private
  ).length;

  const stars = repositories.reduce(
    (total, repo) =>
      total + (repo.stargazers_count ?? 0),
    0
  );

  const forks = repositories.reduce(
    (total, repo) =>
      total + (repo.forks_count ?? 0),
    0
  );

  const rows = [
    ["Repositories", repositories.length],
    ["Public Repos", publicRepos],
    ["Private Repos", privateRepos],
    ["Contributions", contributions.contributions],
    ["Commits", contributions.commits],
    ["Pull Requests", contributions.pullRequests],
    ["Issues", contributions.issues],
    ["Code Reviews", contributions.reviews],
    ["Stars", stars],
    ["Forks", forks],
  ];

  const left = rows.slice(0, 5);
  const right = rows.slice(5);

  const renderRows = (items, x) =>
    items
      .map(
        ([label, value], index) => `
          <text
            x="${x}"
            y="${82 + index * 27}"
            class="label"
          >${escapeXml(label)}</text>

          <text
            x="${x + 180}"
            y="${82 + index * 27}"
            text-anchor="end"
            class="value"
          >${number(value)}</text>
        `
      )
      .join("");

  return `
<svg
  xmlns="http://www.w3.org/2000/svg"
  width="720"
  height="235"
  viewBox="0 0 720 235"
  role="img"
  aria-label="GitHub Engineering Stats"
>
  <style>
    .title {
      font: 600 18px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      fill: #1f2328;
    }

    .subtitle {
      font: 400 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      fill: #656d76;
    }

    .label {
      font: 400 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      fill: #656d76;
    }

    .value {
      font: 600 14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      fill: #1f2328;
    }
  </style>

  <rect
    x="0.5"
    y="0.5"
    width="719"
    height="234"
    rx="8"
    fill="#ffffff"
    stroke="#d0d7de"
  />

  <text
    x="24"
    y="34"
    class="title"
  >GitHub Engineering Stats</text>

  <text
    x="24"
    y="54"
    class="subtitle"
  >${escapeXml(username)} · owner + organization + collaborator repositories</text>

  ${renderRows(left, 24)}
  ${renderRows(right, 390)}
</svg>
`.trim();
}

function createLanguagesSvg(languages) {
  const topLanguages = languages.slice(0, 10);

  const totalBytes = languages.reduce(
    (sum, item) => sum + item.bytes,
    0
  );

  const rows = topLanguages
    .map((item, index) => {
      const percentage =
        totalBytes === 0
          ? 0
          : (item.bytes / totalBytes) * 100;

      const y = 82 + index * 30;
      const barWidth = Math.max(
        2,
        (percentage / 100) * 310
      );

      return `
        <text
          x="24"
          y="${y}"
          class="language"
        >${escapeXml(item.language)}</text>

        <rect
          x="175"
          y="${y - 11}"
          width="310"
          height="9"
          rx="4.5"
          fill="#eaeef2"
        />

        <rect
          x="175"
          y="${y - 11}"
          width="${barWidth.toFixed(2)}"
          height="9"
          rx="4.5"
          fill="#0969da"
        />

        <text
          x="515"
          y="${y}"
          class="percentage"
        >${percentage.toFixed(1)}%</text>
      `;
    })
    .join("");

  const height =
    Math.max(150, 100 + topLanguages.length * 30);

  return `
<svg
  xmlns="http://www.w3.org/2000/svg"
  width="560"
  height="${height}"
  viewBox="0 0 560 ${height}"
  role="img"
  aria-label="Top Languages"
>
  <style>
    .title {
      font: 600 18px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      fill: #1f2328;
    }

    .subtitle {
      font: 400 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      fill: #656d76;
    }

    .language {
      font: 500 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      fill: #1f2328;
    }

    .percentage {
      font: 600 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      fill: #656d76;
    }
  </style>

  <rect
    x="0.5"
    y="0.5"
    width="559"
    height="${height - 1}"
    rx="8"
    fill="#ffffff"
    stroke="#d0d7de"
  />

  <text
    x="24"
    y="34"
    class="title"
  >Top Languages</text>

  <text
    x="24"
    y="54"
    class="subtitle"
  >Aggregated from every repository accessible by STATS_TOKEN</text>

  ${rows}
</svg>
`.trim();
}

async function main() {
  console.log("Authenticating with GitHub...");

  const user = await getAuthenticatedUser();

  if (
    user.login.toLowerCase() !==
    EXPECTED_USERNAME.toLowerCase()
  ) {
    throw new Error(
      `STATS_TOKEN belongs to ${user.login}, expected ${EXPECTED_USERNAME}`
    );
  }

  console.log(`Authenticated as ${user.login}`);

  console.log("Fetching repositories...");

  const repositories = await getAllRepositories();

  console.log(
    `Repositories accessible: ${repositories.length}`
  );

  if (repositories.length === 0) {
    throw new Error(
      "No repositories are accessible using STATS_TOKEN"
    );
  }

  console.log("Aggregating languages...");

  const languages =
    await getLanguageTotals(repositories);

  console.log(
    `Languages detected: ${languages.length}`
  );

  console.log("Fetching contribution history...");

  const contributions =
    await getContributionStats(user.created_at);

  await fs.mkdir("profile", {
    recursive: true,
  });

  await fs.writeFile(
    "profile/stats.svg",
    createStatsSvg({
      username: user.login,
      repositories,
      contributions,
    }),
    "utf8"
  );

  await fs.writeFile(
    "profile/top-langs.svg",
    createLanguagesSvg(languages),
    "utf8"
  );

  console.log("Generated profile/stats.svg");
  console.log("Generated profile/top-langs.svg");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
