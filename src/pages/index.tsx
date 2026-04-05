import type {ReactNode} from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';
import Heading from '@theme/Heading';

import styles from './index.module.css';

function HomepageHeader() {
  const {siteConfig} = useDocusaurusContext();
  return (
    <header className={clsx('hero hero--primary', styles.heroBanner)}>
      <div className="container">
        <Heading as="h1" className="hero__title">
          {siteConfig.title}
        </Heading>
        <p className="hero__subtitle">{siteConfig.tagline}</p>
        <div className={styles.buttons}>
          <Link
            className="button button--secondary button--lg"
            to="/docs/intro">
            Get Started
          </Link>
          <Link
            className="button button--outline button--lg"
            to="/docs/architecture/overview"
            style={{marginLeft: '1rem', color: 'white', borderColor: 'white'}}>
            Architecture
          </Link>
        </div>
      </div>
    </header>
  );
}

type FeatureItem = {
  title: string;
  icon: string;
  description: ReactNode;
};

const features: FeatureItem[] = [
  {
    title: 'AI/ML-Native Storage',
    icon: '\u{1F9E0}',
    description: (
      <>
        Purpose-built for machine learning workflows. Batch GET with TAR+LZ4 streaming,
        epoch-based data loading, deterministic shuffle, and a native PyTorch SDK
        eliminate the I/O bottleneck in training pipelines.
      </>
    ),
  },
  {
    title: 'Rust Performance',
    icon: '\u{26A1}',
    description: (
      <>
        Zero-copy metadata (FlatBuffers MetaView), mandatory SIMD erasure coding
        (12+ GB/s/core), io_uring on Linux, and jemalloc memory management.
        No garbage collector, no runtime overhead.
      </>
    ),
  },
  {
    title: 'S3-Compatible API',
    icon: '\u{1F50C}',
    description: (
      <>
        Drop-in S3 replacement with SigV4 auth, multipart uploads, versioning,
        lifecycle rules, presigned URLs, CORS, and tagging. Works with aws-cli,
        boto3, and every S3-compatible tool.
      </>
    ),
  },
  {
    title: 'Enterprise Ready',
    icon: '\u{1F3E2}',
    description: (
      <>
        Multi-tenancy with QoS isolation, OIDC/LDAP authentication, hash-chain
        audit logging, compliance controls, and active-active replication.
        Ed25519 offline license validation.
      </>
    ),
  },
  {
    title: 'Self-Healing Architecture',
    icon: '\u{1F6E1}\u{FE0F}',
    description: (
      <>
        Reed-Solomon and Locally Repairable Codes (LRC) provide 75% less repair I/O
        than pure RS. Background scanner, priority-based repair queue, on-read
        corruption detection, and automatic data reconstruction.
      </>
    ),
  },
  {
    title: 'Single Binary, Apache 2.0',
    icon: '\u{1F4E6}',
    description: (
      <>
        One binary, one port (9000), one config file. No etcd, no coordinator,
        no complex dependency chain. HLC-based consistency without Raft/Paxos.
        Apache 2.0 licensed - no AGPL restrictions.
      </>
    ),
  },
];

function Feature({title, icon, description}: FeatureItem) {
  return (
    <div className={clsx('col col--4')} style={{marginBottom: '2rem'}}>
      <div className="feature-card" style={{height: '100%'}}>
        <div className="feature-icon">{icon}</div>
        <Heading as="h3">{title}</Heading>
        <p>{description}</p>
      </div>
    </div>
  );
}

function Stats() {
  return (
    <section style={{padding: '3rem 0', background: 'var(--ifm-background-surface-color)'}}>
      <div className="container">
        <div className="stats-grid">
          <div className="stat-card">
            <div className="stat-number">68</div>
            <div className="stat-label">OSS Features</div>
          </div>
          <div className="stat-card">
            <div className="stat-number">57</div>
            <div className="stat-label">Enterprise Features</div>
          </div>
          <div className="stat-card">
            <div className="stat-number">928+</div>
            <div className="stat-label">Tests</div>
          </div>
          <div className="stat-card">
            <div className="stat-number">0</div>
            <div className="stat-label">Clippy Warnings</div>
          </div>
        </div>
      </div>
    </section>
  );
}

export default function Home(): ReactNode {
  return (
    <Layout
      title="Next-Gen Object Storage for AI/ML"
      description="Neolith is a next-generation cloud object storage system built in Rust, designed for AI/ML workloads with S3 compatibility.">
      <HomepageHeader />
      <Stats />
      <main>
        <section style={{padding: '3rem 0'}}>
          <div className="container">
            <div className="row">
              {features.map((props, idx) => (
                <Feature key={idx} {...props} />
              ))}
            </div>
          </div>
        </section>
      </main>
    </Layout>
  );
}
