const CATEGORY_RULES = [
  {
    category: "AI & Machine Learning",
    aliases: ["ai", "machine learning", "llm", "models", "artificial intelligence"],
    hosts: ["huggingface.co", "openai.com", "anthropic.com", "ollama.com", "lmstudio.ai", "qwenlm.ai", "modelscope.cn"],
    keywords: [
      "artificial intelligence",
      "machine learning",
      "large language model",
      "llm",
      "qwen",
      "llama.cpp",
      "multimodal",
      "embedding",
      "rag",
      "gemma",
      "ocr"
    ]
  },
  {
    category: "Shopping & Marketplaces",
    aliases: ["shopping", "marketplace", "stores", "ecommerce"],
    hosts: ["amazon.com", "amazon.fr", "ebay.com", "etsy.com", "aliexpress.com", "temu.com", "shein.com"],
    keywords: ["marketplace", "for sale", "prix", "shopping", "store"]
  },
  {
    category: "Gaming",
    aliases: ["gaming", "games"],
    hosts: ["steamcommunity.com", "store.steampowered.com", "wowhead.com", "battlenet.com", "epicgames.com"],
    keywords: ["game", "gaming", "wowhead", "warcraft", "steam", "playstation", "xbox"]
  },
  {
    category: "Cloud & DevOps",
    aliases: ["cloud", "devops", "infrastructure", "deployment"],
    hosts: ["console.aws.amazon.com", "console.cloud.google.com", "portal.azure.com", "vercel.com", "netlify.com", "cloudflare.com", "docker.com", "kubernetes.io"],
    keywords: ["devops", "deployment", "docker", "kubernetes", "infrastructure", "cloud console"]
  },
  {
    category: "Development",
    aliases: ["development", "developer", "coding", "programming", "projects", "github"],
    hosts: ["github.com", "gitlab.com", "bitbucket.org", "stackoverflow.com", "stackexchange.com", "npmjs.com", "pypi.org", "developer.mozilla.org", "dev.to", "codepen.io"],
    keywords: ["github", "source code", "programming", "developer", "javascript", "typescript", "python", ".net", "api", "sdk"]
  },
  {
    category: "Learning & Education",
    aliases: ["learning", "education", "courses", "study", "school", "tutorials"],
    hosts: ["coursera.org", "udemy.com", "edx.org", "khanacademy.org", "freecodecamp.org", "learn.microsoft.com"],
    keywords: ["course", "tutorial", "roadmap", "lesson", "exercise", "exercice", "learn", "guide", "worksheet"]
  },
  {
    category: "Videos & Entertainment",
    aliases: ["videos", "entertainment", "media", "movies", "music", "youtube"],
    hosts: ["youtube.com", "youtu.be", "vimeo.com", "dailymotion.com", "twitch.tv", "netflix.com"],
    keywords: ["watch online", "movie", "series", "youtube", "podcast", "music", "video"]
  },
  {
    category: "Social & Communities",
    aliases: ["social", "communities", "community", "forums"],
    hosts: ["facebook.com", "instagram.com", "tiktok.com", "linkedin.com", "x.com", "twitter.com", "reddit.com", "discord.com"],
    keywords: ["facebook", "instagram", "linkedin", "social network", "reddit", "discord"]
  },
  {
    category: "Work & Productivity",
    aliases: ["work", "productivity", "office", "documents", "tools"],
    hosts: ["docs.google.com", "drive.google.com", "notion.so", "notion.site", "trello.com", "slack.com", "figma.com", "canva.com", "asana.com"],
    keywords: ["workspace", "dashboard", "console", "project management", "document", "spreadsheet"]
  },
  {
    category: "Finance",
    aliases: ["finance", "financial", "banking", "money"],
    hosts: ["paypal.com", "wise.com", "stripe.com", "binance.com", "coinbase.com"],
    keywords: ["bank", "banking", "finance", "invoice", "payment", "crypto"]
  },
  {
    category: "News & Reading",
    aliases: ["news", "reading", "articles", "blogs"],
    hosts: ["medium.com", "substack.com", "wikipedia.org", "arxiv.org", "news.google.com"],
    keywords: ["article", "news", "blog", "presentation", "research paper", "wikipedia"]
  }
];

function normalize(value) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function hostnameMatches(hostname, ruleHost) {
  return hostname === ruleHost || hostname.endsWith(`.${ruleHost}`);
}

function chooseExistingCategory(category, aliases, existingCategories) {
  const candidates = new Set([...aliases, category].map(normalize));
  for (const existing of existingCategories) {
    if (candidates.has(normalize(existing))) {
      return existing;
    }
  }
  return category;
}

function inferCategory(bookmark, existingCategories) {
  let url;
  try {
    url = new URL(bookmark.url);
  } catch {
    return "Reference";
  }

  const hostname = url.hostname.toLowerCase();
  const titleText = normalize(bookmark.title);
  const pathText = normalize(url.pathname);

  let bestRule = null;
  let bestScore = 0;
  for (const rule of CATEGORY_RULES) {
    const hostScore = rule.hosts.some((host) => (
      hostnameMatches(hostname, host) || hostname === host
    )) ? 6 : 0;
    const keywordScore = rule.keywords.reduce(
      (score, keyword) => {
        const normalizedKeyword = normalize(keyword);
        return score
          + (titleText.includes(normalizedKeyword) ? 8 : 0)
          + (pathText.includes(normalizedKeyword) ? 2 : 0);
      },
      0
    );
    const score = hostScore + keywordScore;
    if (score > bestScore) {
      bestRule = rule;
      bestScore = score;
    }
  }

  if (!bestRule) {
    return chooseExistingCategory("Reference", ["reference", "resources", "archive"], existingCategories);
  }
  return chooseExistingCategory(
    bestRule.category,
    bestRule.aliases,
    existingCategories
  );
}

function isObviousTemporaryLink(bookmark) {
  let url;
  try {
    url = new URL(bookmark.url);
  } catch {
    return false;
  }

  const searchable = `${url.pathname}${url.search}`.toLowerCase();
  return (
    /\/(?:oauth2?|auth|sso)\/callback(?:\/|$)/.test(searchable)
    || /(?:^|[?&])(code|access_token|refresh_token|oauth_token)=/.test(url.search)
    || searchable.includes("callback?state=")
  );
}

export function classifyBookmarksLocally(bookmarks, existingCategories = [], reason = "", options = {}) {
  const allowDeletion = options.allowDeletion !== false;
  return bookmarks.map((bookmark) => {
    if (isObviousTemporaryLink(bookmark)) {
      if (!allowDeletion) {
        return {
          id: bookmark.id,
          action: "keep",
          title: bookmark.title,
          folderPath: bookmark.path,
          reason: reason || "Potential callback/token URL detected, but deletion mode is disabled.",
          confidence: 0.9,
          source: "local"
        };
      }
      return {
        id: bookmark.id,
        action: "delete",
        title: bookmark.title,
        folderPath: bookmark.path,
        reason: "Obvious authentication callback or one-time token URL detected locally.",
        confidence: 0.88,
        source: "local"
      };
    }

    const category = inferCategory(bookmark, existingCategories);
    const currentOrganizablePath = bookmark.path.filter((segment) => ![
      "Bookmarks bar",
      "Other bookmarks",
      "Mobile bookmarks",
      "AI Organized"
    ].includes(segment));
    const moved = currentOrganizablePath.length !== 1
      || normalize(currentOrganizablePath[0]) !== normalize(category);

    return {
      id: bookmark.id,
      action: moved ? "move" : "keep",
      title: bookmark.title,
      folderPath: [category],
      reason: reason || `Organized locally by bookmark domain and title into "${category}".`,
      confidence: moved ? 0.72 : 0.8,
      source: "local"
    };
  });
}
