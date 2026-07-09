import { describe, it, expect } from 'vitest';
import { buildInstructions } from '../instructions.ts';

/**
 * Characterization tests pinning the exact rendered '## Specialist subagents'
 * bullet text across representative tool-enablement configs. These exist
 * specifically to prove that consolidating the always-on and tool-gated
 * bullet sources into a single ordered list is behavior-preserving — every
 * snapshot here must be byte-for-byte identical before and after that
 * refactor.
 */
describe('buildInstructions — specialist subagent bullets (characterization)', () => {
  it('renders the full specialist subagents section with all tools enabled', () => {
    expect(buildInstructions()).toMatchSnapshot();
  });

  it('renders with only awsCli enabled (a single-key gated group)', () => {
    expect(buildInstructions(new Set(['kubectl', 'awsCli']))).toMatchSnapshot();
  });

  it('renders with only prometheusQuery enabled (golden-signals OR-gate via one key)', () => {
    expect(buildInstructions(new Set(['kubectl', 'prometheusQuery']))).toMatchSnapshot();
  });

  it('renders with no optional tools enabled (only always-on specialists appear)', () => {
    expect(buildInstructions(new Set(['kubectl']))).toMatchSnapshot();
  });
});
