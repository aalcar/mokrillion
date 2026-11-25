// Registers the bot's slash commands. Run once after creating the bot, and again if commands change.
//   env: DISCORD_TOKEN, DISCORD_CLIENT_ID, optional DISCORD_GUILD_ID (instant, server-only registration)
import { REST, Routes } from "discord.js";

const { DISCORD_TOKEN: token, DISCORD_CLIENT_ID: clientId, DISCORD_GUILD_ID: guildId } = process.env;
if (!token || !clientId) throw new Error("DISCORD_TOKEN and DISCORD_CLIENT_ID must be set");

const commands = [
  { name: "play", description: "Play today's Mokrillion (questions arrive in your DMs)" },
  { name: "share", description: "Post your score for today's Mokrillion" },
];

const rest = new REST({ version: "10" }).setToken(token);
await rest.put(guildId ? Routes.applicationGuildCommands(clientId, guildId) : Routes.applicationCommands(clientId), { body: commands });
console.log(`Registered ${commands.length} commands ${guildId ? `in server ${guildId}` : "globally (may take up to an hour)"}`);
