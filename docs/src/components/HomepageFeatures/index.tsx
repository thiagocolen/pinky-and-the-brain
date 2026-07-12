import type {ReactNode} from 'react';
import clsx from 'clsx';
import Heading from '@theme/Heading';
import styles from './styles.module.css';

type FeatureItem = {
  title: string;
  Svg: React.ComponentType<React.ComponentProps<'svg'>>;
  description: ReactNode;
};

const FeatureList: FeatureItem[] = [
  {
    title: 'Multi-Agent LangGraph Orchestration',
    Svg: require('@site/static/img/undraw_docusaurus_mountain.svg').default,
    description: (
      <>
        A cyclic LangGraph.js graph routes every query through a supervisor
        ("The Brain") to specialist RAG agents for AWS, cellular automata,
        English certification, and technical interview prep.
      </>
    ),
  },
  {
    title: 'Multiple Protocol Entrypoints',
    Svg: require('@site/static/img/undraw_docusaurus_tree.svg').default,
    description: (
      <>
        Talk to the same agent workflow through a raw ACP stdin/stdout server,
        an interactive REPL CLI, an Express REST API with SSE streaming, or a
        Model Context Protocol (MCP) server.
      </>
    ),
  },
  {
    title: 'Cloud-Native Persistence',
    Svg: require('@site/static/img/undraw_docusaurus_react.svg').default,
    description: (
      <>
        Conversation state is checkpointed locally via a WAL-mode SQLite
        checkpointer, with an S3-backed storage wrapper (and offline mock
        fallback) for cloud deployments on AWS ECS.
      </>
    ),
  },
];

function Feature({title, Svg, description}: FeatureItem) {
  return (
    <div className={clsx('col col--4')}>
      <div className="text--center">
        <Svg className={styles.featureSvg} role="img" />
      </div>
      <div className="text--center padding-horiz--md">
        <Heading as="h3">{title}</Heading>
        <p>{description}</p>
      </div>
    </div>
  );
}

export default function HomepageFeatures(): ReactNode {
  return (
    <section className={styles.features}>
      <div className="container">
        <div className="row">
          {FeatureList.map((props, idx) => (
            <Feature key={idx} {...props} />
          ))}
        </div>
      </div>
    </section>
  );
}
