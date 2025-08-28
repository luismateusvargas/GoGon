import { DELAY_BETWEEN_MESSAGES, RETRY_DELAY } from './webhooks.js';

const messageQueue = [];
let processingQueue = false;

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function queueDiscordMessage(webhook, payload) {
  messageQueue.push({ webhook, payload });
  processQueue();
}

export async function processQueue() {
  if (processingQueue) return;
  processingQueue = true;
  while (messageQueue.length) {
    const { webhook, payload } = messageQueue[0];
    try {
      await securePost(webhook, payload);
      messageQueue.shift();
      await sleep(DELAY_BETWEEN_MESSAGES);
    } catch (err) {
      if (err.status === 429) {
        await sleep(err.retryAfter || DELAY_BETWEEN_MESSAGES);
      } else {
        console.error('queueDiscordMessage error:', err);
        messageQueue.shift();
      }
    }
  }
  processingQueue = false;
}

export function getContent(where) {
  return GM_getValue(where, '');
}

export function setContent(where, content) {
  GM_setValue(where, content);
}

export function addLine(newLine, where) {
  let conteudo = getContent(where);
  let linhas = conteudo.split('\n');
  linhas.push(newLine);
  if (linhas.length > 20) {
    linhas.shift();
  }
  conteudo = linhas.join('\n');
  setContent(where, conteudo);
}

export function checkInfo(line, where) {
  let conteudo = getContent(where);
  let linhas = conteudo.split('\n');
  return linhas.includes(line);
}

export async function secureFetch(url, options = {}, retries = 3) {
  const defaultHeaders = {
    Accept: '*/*',
    'Accept-Language': 'en-US,en;q=0.8,pt-BR;q=0.5,pt;q=0.3'
  };
  const merged = {
    credentials: 'include',
    ...options,
    headers: { ...defaultHeaders, ...(options.headers || {}) }
  };
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, merged);
      if (response.status === 200 || response.status === 204) {
        return response;
      }
      if (response.status === 502 || response.status === 504) {
        if (attempt < retries) {
          await sleep(RETRY_DELAY);
          continue;
        }
        throw new Error(`Server error: ${response.status}`);
      }
      throw new Error(`Request failed: ${response.status}`);
    } catch (err) {
      if (attempt < retries) {
        await sleep(RETRY_DELAY);
      } else {
        console.error('secureFetch error:', err);
        throw err;
      }
    }
  }
}

export function securePost(url, payload, retries = 3) {
  const defaultHeaders = {
    'Content-Type': 'application/json',
    Accept: '*/*',
    'Accept-Language': 'en-US,en;q=0.8,pt-BR;q=0.5,pt;q=0.3'
  };
  return new Promise((resolve, reject) => {
    function attempt(remaining) {
      GM_xmlhttpRequest({
        method: 'POST',
        url,
        headers: defaultHeaders,
        data: JSON.stringify(payload),
        onload: function (response) {
          if (response.status === 200 || response.status === 204) {
            resolve(response);
          } else if (response.status === 429) {
            const match = /retry-after:\s*(\d+)/i.exec(response.responseHeaders || '');
            const retryAfter = match ? parseInt(match[1], 10) * 1000 : null;
            const err = new Error('Rate limited');
            err.status = 429;
            err.retryAfter = retryAfter;
            reject(err);
          } else if ((response.status === 502 || response.status === 504) && remaining > 0) {
            setTimeout(() => attempt(remaining - 1), RETRY_DELAY);
          } else if (response.status === 502 || response.status === 504) {
            const err = new Error(`Server unavailable: ${response.status}`);
            err.status = response.status;
            reject(err);
          } else {
            const err = new Error(`HTTP error: ${response.status}`);
            err.status = response.status;
            reject(err);
          }
        },
        onerror: function () {
          if (remaining > 0) {
            setTimeout(() => attempt(remaining - 1), RETRY_DELAY);
          } else {
            reject(new Error('Network error'));
          }
        }
      });
    }
    attempt(retries);
  });
}

export function sendDiscordMessage(message, wTitle, colorCode, footerText, group, webhook) {
  const embed = {
    title: wTitle,
    description: message,
    color: colorCode,
    footer: {
      text: footerText
    }
  };

  queueDiscordMessage(webhook, { content: group, embeds: [embed] });
  securePost(webhook, { content: group, embeds: [embed] }).catch(err =>
    console.error('sendDiscordMessage error:', err)
  );
}

export function sendSimpleMessage(message, webhook) {
  securePost(webhook, { content: message }).catch(err =>
    console.error('sendSimpleMessage error:', err)
  );
}

export function sendExtraDiscordMessage(
  message,
  wTitle,
  colorCode,
  footerText,
  group,
  webhook,
  thumbUrl,
  thumb
) {
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

  queueDiscordMessage(webhook, { content: group, embeds: [embed] });
  securePost(webhook, { content: group, embeds: [embed] }).catch(err =>
    console.error('sendExtraDiscordMessage error:', err)
  );
}

export function sendExtraDiscordMessageNODROP(
  message,
  wTitle,
  colorCode,
  footerText,
  group,
  webhook,
  thumbUrl
) {
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

  queueDiscordMessage(webhook, { content: group, embeds: [embed] });
  securePost(webhook, { content: group, embeds: [embed] }).catch(err =>
    console.error('sendExtraDiscordMessageNODROP error:', err)
  );
}

export async function getGoldInHand(targetLink) {
  let response = await secureFetch(targetLink);
  let text = await response.text();
  let tempElement = document.createElement('div');
  tempElement.innerHTML = text;
  let goldInHandElement = tempElement.querySelector('#stat-gold');
  if (goldInHandElement) {
    return goldInHandElement.textContent;
  }
  return null;
}

export async function getBuffs(targetLink) {
  let response = await secureFetch(targetLink);
  let text = await response.text();
  let tempElement = document.createElement('div');
  tempElement.innerHTML = text;
  let isCloaked = false;
  let hasDeflect = false;
  let buffNameAndLevel = [];
  let trs = tempElement.querySelectorAll('#profileRightColumn > div:nth-child(14) > table > tbody > tr');
  trs.forEach(tr => {
    let tds = tr.querySelectorAll('td');
    tds.forEach(td => {
      let img = td.querySelector('img');
      if (img) {
        let tipped = img.getAttribute('data-tipped');
        let span = document.createElement('div');
        span.innerHTML = tipped;
        let buffName = span.querySelector('span > b').textContent;
        let level = span
          .querySelector('span')
          .textContent.split('Level: ')[1]
          .split(')')[0];
        buffNameAndLevel.push({ name: buffName, level: level });
      }
    });
  });
  buffNameAndLevel.forEach(buff => {
    if (buff.name === 'Deflect') {
      hasDeflect = true;
    }
    if (buff.name === 'Cloak') {
      isCloaked = true;
    }
  });
  return { hasDeflect: hasDeflect, isCloaked: isCloaked, numberOfBuffs: buffNameAndLevel.length };
}
