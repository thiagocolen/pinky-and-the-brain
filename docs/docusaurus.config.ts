import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

const config: Config = {
  title: 'Pinky and the Brain Agents',
  tagline: 'A guided teaching and article-writing agent on AWS, built with Deep Agents on LangGraph.js',
  favicon: 'img/favicon.ico',

  // Set the production url of your site here
  url: 'https://thiagocolen.github.io',
  // Set the /<projectName>/ path for GitHub pages
  baseUrl: '/pinky-and-the-brain/',

  // GitHub pages deployment config.
  organizationName: 'thiagocolen', // Usually your GitHub org/user name.
  projectName: 'pinky-and-the-brain', // Usually your repo name.
  deploymentBranch: 'gh-pages',
  trailingSlash: false,

  onBrokenLinks: 'throw',
  onBrokenMarkdownLinks: 'warn',

  markdown: {
    mermaid: true,
  },
  themes: ['@docusaurus/theme-mermaid'],

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      {
        docs: {
          sidebarPath: './sidebars.ts',
          editUrl: 'https://github.com/thiagocolen/pinky-and-the-brain/edit/master/docs/',
        },
        blog: {
          showReadingTime: true,
          feedOptions: {
            type: 'all',
            copyright: `Copyright (c) ${new Date().getFullYear()} thiagocolen.`,
          },
        },
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    image: 'img/docusaurus-social-card.jpg',
    navbar: {
      title: 'Pinky and the Brain',
      logo: {
        alt: 'Pinky and the Brain Logo',
        src: 'img/logo.png',
      },
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'tutorialSidebar',
          position: 'left',
          label: 'Docs',
        },
        {to: '/blog', label: 'Blog', position: 'left'},
        {
          href: 'https://github.com/thiagocolen/pinky-and-the-brain',
          label: 'GitHub',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Docs',
          items: [
            {
              label: 'Introduction',
              to: '/docs/intro',
            },
          ],
        },
        {
          title: 'Community',
          items: [
            {
              label: 'GitHub Issues',
              href: 'https://github.com/thiagocolen/pinky-and-the-brain/issues',
            },
          ],
        },
      ],
      copyright: `Copyright (c) ${new Date().getFullYear()} thiagocolen. Built with Docusaurus.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
