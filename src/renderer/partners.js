// SPDX-License-Identifier: GPL-3.0-only
(() => {
  'use strict';
  const catalog = [{
    id: 'ahs-conflict',
    name: 'AHS Conflict',
    community: 'Armaholics · Arma Reforger',
    cover: 'assets/partners/ahs-conflict-cover.png',
    avatar: 'assets/partners/ahs-conflict-avatar.png',
    discord: 'https://discord.gg/nYrfdPqRD',
    titleKey: 'partners.ahs.welcome',
    descriptionKeys: ['partners.ahs.intro', 'partners.ahs.maps', 'partners.ahs.events']
  }];
  const byId = new Map(catalog.map(partner => [partner.id, partner]));
  const $ = selector => document.querySelector(selector);
  const t = (key, values) => window.launcherI18n.t(key, values);
  let mounted = false;
  let selectedId = null;
  let gridLanguage = '';
  let detailKey = '';

  function discordUrl(value) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.hostname !== 'discord.gg'
        || !/^\/[a-zA-Z0-9-]+\/?$/.test(url.pathname) || url.username || url.password) return '';
      return url.href;
    } catch { return ''; }
  }

  function renderGrid(language) {
    if (gridLanguage === language) return;
    gridLanguage = language;
    const cards = catalog.map(partner => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'partner-card';
      button.dataset.partnerId = partner.id;
      button.setAttribute('aria-label', t('partners.openCard', { name: partner.name }));
      const cover = document.createElement('img');
      cover.className = 'partner-cover';
      cover.src = partner.cover;
      cover.alt = '';
      cover.width = 72;
      cover.height = 72;
      const name = document.createElement('strong');
      name.textContent = partner.name;
      const arrow = document.createElement('img');
      arrow.className = 'partner-card-arrow';
      arrow.src = 'assets/icons/chevron-right.svg';
      arrow.alt = '';
      button.append(cover, name, arrow);
      return button;
    });
    $('#partnersGrid').replaceChildren(...cards);
  }

  function render() {
    const language = window.launcherI18n.getLanguage();
    renderGrid(language);
    const partner = byId.get(selectedId);
    $('#partnersGrid').hidden = Boolean(partner);
    $('#partnerDetail').hidden = !partner;
    $('#partnersBack span').textContent = t('partners.back');
    if (!partner) return;
    const nextKey = `${language}:${partner.id}`;
    if (detailKey === nextKey) return;
    detailKey = nextKey;
    $('#partnerAvatar').src = partner.avatar;
    $('#partnerAvatar').alt = t('partners.logo', { name: partner.name });
    $('#partnerCommunity').textContent = partner.community;
    $('#partnerTitle').textContent = t(partner.titleKey);
    $('#partnerDescription').replaceChildren(...partner.descriptionKeys.map(key => {
      const paragraph = document.createElement('p');
      paragraph.textContent = t(key);
      return paragraph;
    }));
    const discord = $('#partnerDiscord');
    const url = discordUrl(partner.discord);
    if (url) discord.href = url;
    else discord.removeAttribute('href');
    discord.setAttribute('aria-disabled', String(!url));
    discord.title = t('partners.discordHint');
    discord.querySelector('span').textContent = t('partners.discord', { name: partner.name });
  }

  function openPartner(id) {
    if (!byId.has(id)) return;
    selectedId = id;
    render();
    $('#view-partners').scrollTop = 0;
    $('#partnerTitle').focus({ preventScroll: true });
  }

  function showList() {
    const previousId = selectedId;
    selectedId = null;
    render();
    $('#view-partners').scrollTop = 0;
    const card = [...$('#partnersGrid').children].find(element => element.dataset.partnerId === previousId);
    card?.focus({ preventScroll: true });
  }

  function mount() {
    if (mounted) return;
    mounted = true;
    $('#partnersGrid').addEventListener('click', event => {
      const card = event.target.closest('[data-partner-id]');
      if (card) openPartner(card.dataset.partnerId);
    });
    $('#partnersBack').addEventListener('click', showList);
    $('#partnerDiscord').addEventListener('click', event => {
      if (!event.currentTarget.hasAttribute('href')) event.preventDefault();
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !event.defaultPrevented && selectedId
        && $('#view-partners').classList.contains('active') && !document.querySelector('dialog[open]')) {
        event.preventDefault();
        showList();
      }
    });
    render();
  }

  window.launcherPartners = { mount, render };
})();
