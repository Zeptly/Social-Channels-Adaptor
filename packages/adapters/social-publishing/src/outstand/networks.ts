import type { NetworkDescriptor, SocialCapabilities, SocialNetwork } from "../contract/index.js";

/**
 * Outstand network catalog for Social Publishing (version-controlled).
 *
 * Every flag states what the Outstand Gateway exposes on a network, and
 * each one rests on verified evidence (docs/OUTSTAND.md → "Evidence"):
 *  - connect/publish/schedule/media/delete/analytics: Outstand REST contract
 *    (official @outstand-so/ui wire types + reference implementation).
 *  - conversations/directMessages: Outstand documents Instagram Direct Messages
 *    only. Every other network is `false`: no universal inbox is implied.
 *  - comments/firstComment: Outstand exposes comment endpoints, but no
 *    Zeptly requirement or verified wire contract covers them in V1 → `false`.
 *
 * Constraints are the conservative documented platform limits curated in the
 * reference implementation's channel specifications (verified 2026-09-23).
 */
export const OUTSTAND_SOCIAL_CATALOG_VERSION = "2026.09.24-1";

const BASE: SocialCapabilities = {
  connect: true,
  publish: true,
  schedule: true,
  media: true,
  analytics: true,
  comments: false,
  conversations: false,
  directMessages: false,
  delete: true,
  firstComment: false,
};

export const OUTSTAND_SOCIAL_NETWORKS: Readonly<Record<SocialNetwork, NetworkDescriptor>> = {
  linkedin: {
    network: "linkedin",
    displayName: "LinkedIn",
    capabilities: { ...BASE },
    constraints: {
      maxTextLength: 3000,
      textRequired: true,
      mediaRequired: false,
      maxMediaItems: 20,
      allowMixedMedia: false,
      image: { maxItems: 20, mimeTypes: ["image/jpeg", "image/png", "image/gif"] },
      video: { maxItems: 1, mimeTypes: ["video/mp4"], maxSizeBytes: 524_288_000 },
      options: [],
    },
    notes: ["Personal profiles and organization pages are separate connections (accountType)."],
  },
  instagram: {
    network: "instagram",
    displayName: "Instagram",
    capabilities: { ...BASE, conversations: true, directMessages: true },
    constraints: {
      maxTextLength: 2200,
      textRequired: false,
      mediaRequired: true,
      maxMediaItems: 10,
      allowMixedMedia: true,
      image: { maxItems: 10, mimeTypes: ["image/jpeg"], maxSizeBytes: 8_388_608 },
      video: { maxItems: 10, mimeTypes: ["video/mp4", "video/quicktime"], maxSizeBytes: 314_572_800 },
      options: [
        { key: "mediaType", type: "enum", required: false, values: ["FEED", "REELS", "STORIES"] },
        { key: "shareToFeed", type: "boolean", required: false },
        { key: "isAiGenerated", type: "boolean", required: false, description: "Meta AI-content disclosure (is_ai_generated → \"AI info\" label)" },
      ],
    },
    notes: [
      "Requires an Instagram Business/Creator account.",
      "Direct messages: only conversations started by the contact; replies within Meta's 24-hour window; no history before connection.",
    ],
  },
  facebook: {
    network: "facebook",
    displayName: "Facebook",
    capabilities: { ...BASE },
    constraints: {
      maxTextLength: 63_206,
      textRequired: false,
      mediaRequired: false,
      maxMediaItems: 10,
      allowMixedMedia: false,
      image: { maxItems: 10, mimeTypes: ["image/jpeg", "image/png", "image/gif", "image/bmp", "image/tiff"], maxSizeBytes: 4_194_304 },
      video: { maxItems: 1, mimeTypes: ["video/mp4", "video/quicktime"], maxSizeBytes: 10_737_418_240 },
      options: [
        { key: "publishAsReel", type: "boolean", required: false, description: "Publish as a Page Reel: exactly one video; caption allowed" },
        { key: "publishAsStory", type: "boolean", required: false, description: "Publish as a Page Story: one image or video; no caption" },
      ],
    },
    notes: [
      "Publishes to Facebook Pages. The user selects pages during provisioning.",
      "Reels and Stories are separate Graph API edges: a 9:16 video without publishAsReel is a plain Page video. publishAsReel and publishAsStory are mutually exclusive.",
    ],
  },
  threads: {
    network: "threads",
    displayName: "Threads",
    capabilities: { ...BASE },
    constraints: {
      maxTextLength: 500,
      textRequired: false,
      mediaRequired: false,
      maxMediaItems: 10,
      allowMixedMedia: true,
      image: { maxItems: 10, mimeTypes: ["image/jpeg", "image/png"], maxSizeBytes: 8_388_608 },
      video: { maxItems: 10, mimeTypes: ["video/mp4", "video/quicktime"], maxSizeBytes: 1_073_741_824 },
      options: [{ key: "replyControl", type: "enum", required: false, values: ["everyone", "accounts_you_follow", "mentioned_only"] }],
    },
    notes: [],
  },
  tiktok: {
    network: "tiktok",
    displayName: "TikTok",
    capabilities: { ...BASE },
    constraints: {
      maxTextLength: 2200,
      textRequired: false,
      mediaRequired: true,
      maxMediaItems: 1,
      allowMixedMedia: false,
      video: { maxItems: 1, mimeTypes: ["video/mp4", "video/webm", "video/quicktime"], maxSizeBytes: 4_294_967_296 },
      options: [
        { key: "privacyLevel", type: "enum", required: true, values: ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "SELF_ONLY"] },
        { key: "disableDuet", type: "boolean", required: false },
        { key: "disableStitch", type: "boolean", required: false },
        { key: "disableComment", type: "boolean", required: false },
      ],
    },
    notes: ["Video posts only (photo mode is not evidenced through Outstand).", "Unaudited TikTok apps may be restricted to SELF_ONLY."],
  },
  pinterest: {
    network: "pinterest",
    displayName: "Pinterest",
    capabilities: { ...BASE },
    constraints: {
      maxTextLength: 500,
      textRequired: false,
      mediaRequired: true,
      maxMediaItems: 1,
      allowMixedMedia: false,
      image: { maxItems: 1, mimeTypes: ["image/jpeg", "image/png"], maxSizeBytes: 20_971_520 },
      video: { maxItems: 1, mimeTypes: ["video/mp4", "video/quicktime"], maxSizeBytes: 2_147_483_648 },
      options: [{ key: "boardId", type: "string", required: true, description: "Target Pinterest board id (sent as pinterest.board_id)" }],
    },
    notes: ["Every Pin needs one image or video and a board.", "Pin title and destination link are not mapped in V1 (not evidenced in Outstand sources)."],
  },
  youtube: {
    network: "youtube",
    displayName: "YouTube",
    capabilities: { ...BASE },
    constraints: {
      maxTextLength: 5000,
      textRequired: false,
      mediaRequired: true,
      maxMediaItems: 1,
      allowMixedMedia: false,
      video: {
        maxItems: 1,
        mimeTypes: ["video/mp4", "video/quicktime", "video/webm", "video/x-msvideo", "video/mpeg"],
        maxSizeBytes: 274_877_906_944,
      },
      options: [
        { key: "title", type: "string", required: true, maxLength: 100 },
        { key: "privacyStatus", type: "enum", required: true, values: ["public", "unlisted", "private"] },
        { key: "categoryId", type: "string", required: false },
        { key: "tags", type: "string_array", required: false },
      ],
    },
    notes: ["Post text becomes the video description."],
  },
  bluesky: {
    network: "bluesky",
    displayName: "Bluesky",
    capabilities: { ...BASE },
    constraints: {
      maxTextLength: 300,
      textRequired: false,
      mediaRequired: false,
      maxMediaItems: 4,
      allowMixedMedia: false,
      image: { maxItems: 4, mimeTypes: ["image/jpeg", "image/png", "image/webp"], maxSizeBytes: 1_000_000 },
      video: { maxItems: 1, mimeTypes: ["video/mp4"], maxSizeBytes: 104_857_600 },
      options: [],
    },
    notes: [
      "No OAuth: connects with a handle and an app password.",
      "provider_managed: Outstand's hosted flow collects the app password (no credentials touch Zeptly or this service).",
      "credentials: Zeptly may submit handle + app password; forwarded once to Outstand and never persisted.",
    ],
  },
};
