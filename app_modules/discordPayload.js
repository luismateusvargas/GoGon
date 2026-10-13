// app_modules/discordPayload.js - Discord message bodies for monitor alerts.
// Shared by utils.js (sendDiscordMessage/sendExtraDiscordMessage*) and by monitors that store the
// body in the notification outbox, so a replayed alert has exactly the format of a direct one.

export function basicDiscordPayload(message, wTitle, colorCode, footerText, group) {
  const embed = {
    title: wTitle,
    description: message,
    color: colorCode,
    footer: {
      text: footerText
    }
  };
  return { content: group, embeds: [embed] };
}

export function extraDiscordPayload(message, wTitle, colorCode, footerText, group, thumbUrl, thumb) {
  const embed = {
    title: wTitle,
    description: message,
    image: {
      url: thumbUrl
    },
    thumbnail: {
      url: thumb
    },
    color: colorCode,
    footer: {
      text: footerText
    }
  };
  return { content: group, embeds: [embed] };
}

export function noDropDiscordPayload(message, wTitle, colorCode, footerText, group, thumbUrl) {
  const embed = {
    title: wTitle,
    description: message,
    image: {
      url: thumbUrl
    },
    color: colorCode,
    footer: {
      text: footerText
    }
  };
  return { content: group, embeds: [embed] };
}
