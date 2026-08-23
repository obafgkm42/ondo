const discordApiBaseUrl = "https://discord.com/api/v10";

const applicationId = requiredSnowflake(
  "DISCORD_APPLICATION_ID",
  process.env.DISCORD_APPLICATION_ID,
);
const guildId = requiredSnowflake(
  "DISCORD_GUILD_ID",
  process.env.DISCORD_GUILD_ID,
);
const botToken = requiredValue(
  "DISCORD_BOT_TOKEN",
  process.env.DISCORD_BOT_TOKEN,
);

const command = {
  name: "scanner",
  description: "Query the read-only SP500 scanner",
  description_localizations: {
    "zh-TW": "查詢唯讀 SP500 掃描器",
  },
  type: 1,
  default_member_permissions: "0",
  options: [
    {
      name: "status",
      description: "Run one private live market-status query",
      description_localizations: {
        "zh-TW": "執行一次私密即時市場狀態查詢",
      },
      type: 1,
    },
    {
      name: "repair",
      description: "Explain the repair mechanisms and stress levels",
      description_localizations: {
        "zh-TW": "說明修復機制、門檻與壓力分級",
      },
      type: 1,
    },
    {
      name: "help",
      description: "Show command usage and privacy behavior",
      description_localizations: {
        "zh-TW": "顯示指令用法與隱私行為",
      },
      type: 1,
    },
  ],
};

const response = await fetch(
  `${discordApiBaseUrl}/applications/${applicationId}/guilds/${guildId}/commands`,
  {
    method: "POST",
    headers: {
      Authorization: `Bot ${botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
  },
);

if (!response.ok) {
  const errorBody = await response.text();
  throw new Error(
    `Discord command registration failed (${response.status}): ${errorBody}`,
  );
}

const registeredCommand = await response.json();
console.log(
  `Registered /${registeredCommand.name} for guild ${guildId} (${registeredCommand.id})`,
);

function requiredSnowflake(name, value) {
  const resolvedValue = requiredValue(name, value);
  if (!/^\d{17,20}$/.test(resolvedValue)) {
    throw new Error(`${name} must be a Discord snowflake ID`);
  }
  return resolvedValue;
}

function requiredValue(name, value) {
  const resolvedValue = value?.trim() ?? "";
  if (resolvedValue.length === 0) {
    throw new Error(`${name} is required`);
  }
  return resolvedValue;
}
