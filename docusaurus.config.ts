import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

const config: Config = {
  title: 'Neolith',
  tagline: 'Next-generation cloud object storage built in Rust for AI/ML workloads',
  favicon: 'img/favicon.ico',

  future: {
    v4: true,
  },

  url: 'https://neolith.dev',
  baseUrl: '/',

  organizationName: 'muratkars',
  projectName: 'neolith',

  onBrokenLinks: 'throw',
  onBrokenMarkdownLinks: 'warn',

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
          editUrl: 'https://github.com/muratkars/neolith-docs/edit/main/',
          lastVersion: '0.4',
          versions: {
            current: {
              label: 'Next',
              path: 'next',
            },
            '0.4': {
              label: '0.4',
            },
          },
        },
        blog: {
          showReadingTime: true,
          feedOptions: {
            type: ['rss', 'atom'],
            xslt: true,
          },
          editUrl: 'https://github.com/muratkars/neolith-docs/edit/main/',
        },
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    image: 'img/logo.svg',
    colorMode: {
      defaultMode: 'dark',
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: 'Neolith',
      logo: {
        alt: 'Neolith Logo',
        src: 'img/logo.svg',
      },
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'docsSidebar',
          position: 'left',
          label: 'Docs',
        },
        {to: '/blog', label: 'Blog', position: 'left'},
        {
          type: 'docsVersionDropdown',
          position: 'right',
          dropdownActiveClassDisabled: true,
        },
        {
          href: 'https://github.com/muratkars/neolith',
          label: 'GitHub',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Documentation',
          items: [
            {label: 'Getting Started', to: '/docs/intro'},
            {label: 'Architecture', to: '/docs/architecture/overview'},
            {label: 'S3 API', to: '/docs/s3-api/overview'},
            {label: 'AI/ML', to: '/docs/ai-ml/overview'},
          ],
        },
        {
          title: 'Community',
          items: [
            {label: 'GitHub', href: 'https://github.com/muratkars/neolith'},
            {label: 'Discussions', href: 'https://github.com/muratkars/neolith/discussions'},
          ],
        },
        {
          title: 'More',
          items: [
            {label: 'Blog', to: '/blog'},
            {label: 'Enterprise', to: '/docs/enterprise/overview'},
          ],
        },
      ],
      copyright: `Copyright ${new Date().getFullYear()} Neolith Contributors. Apache 2.0 License.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ['bash', 'toml', 'rust', 'python', 'json'],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
