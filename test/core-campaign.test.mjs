import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, copyFileSync, cpSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createCoreCampaignClient } from '../examples/openai-harness/core-campaign-client.mjs';
import { AgentPayClient } from '../src/index.ts';
import { extractSemanticOutcome, loadScenarioDefinition } from '../scripts/run-scenarios.mjs';

const scenario = {
  name: 'base-mainnet-research-brief-ready',
  targetUrl: 'https://merchant.example/demo-merchant/research-brief/base-mainnet',
  method: 'POST',
};
const offer = {scheme:'exact', network:'eip155:8453', asset:'0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', amount:'1000'};
function prepared() {
  return {
    kind:'ready', nextAction:'execute', protocol:'x402',
    request:{url:scenario.targetUrl, method:'POST', body:'{}'},
    paymentRequirement:{protocol:'x402', amountType:'exact', precision:6, network:offer.network, asset:offer.asset, amountMinor:'1000'},
    challengeDetails:{accepts:[{...offer}]},
  };
}
function fixture() {
  const client = {preparePaidRequest:vi.fn(), executePreparedRequest:vi.fn().mockResolvedValue({kind:'success'})};
  const onAttempt = vi.fn().mockResolvedValue(undefined);
  return {client, onAttempt, guard:createCoreCampaignClient({client, scenario, campaignId:'run-1', onAttempt})};
}

describe('core campaign caller limits', () => {
  it.each([
    ['base-sepolia','eip155:84532','0x036CbD53842c5426634e7929541eC2318f3dCF7e'],
    ['base-mainnet',offer.network,offer.asset],
    ['solana-devnet','solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1','4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'],
    ['solana-mainnet','solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp','EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'],
  ])('accepts actual SDK preparation for %s USDC', async (rail, network, asset) => {
    const targetUrl=`https://merchant.example/demo-merchant/research-brief/${rail}`;
    const challenge={x402Version:2,resource:{url:targetUrl},accepts:[{scheme:'exact',network,asset,amount:'1000',payTo:'merchant',extra:{name:'USDC',version:'2'}}]};
    const sdk=new AgentPayClient({organization:'org',agent:'agent',controlPlaneBaseUrl:'https://control.example',auth:{type:'runtimeToken',runtimeToken:'test'},fetch:vi.fn().mockResolvedValue(new Response('{}',{status:402,headers:{'payment-required':Buffer.from(JSON.stringify(challenge)).toString('base64')}}))});
    const executePreparedRequest=vi.fn().mockResolvedValue({kind:'success'});
    const guard=createCoreCampaignClient({client:{preparePaidRequest:sdk.preparePaidRequest.bind(sdk),executePreparedRequest},scenario:{name:rail,targetUrl,method:'POST'},campaignId:'test',onAttempt:vi.fn()});
    const value=await guard.preparePaidRequest(targetUrl,{method:'POST',body:'{}'});
    await guard.executePreparedRequest(value);
    expect(executePreparedRequest).toHaveBeenCalledOnce();
  });
  it('records intent before execution and uses the caller business key', async () => {
    const {client, onAttempt, guard} = fixture();
    onAttempt.mockImplementation(() => {expect(client.executePreparedRequest).not.toHaveBeenCalled();});
    const request = prepared();
    await guard.executePreparedRequest(request, {idempotencyKey:'model-supplied'});
    expect(client.executePreparedRequest).toHaveBeenCalledWith(request, {idempotencyKey:`scenario-core:run-1:${scenario.name}`});
    expect(onAttempt).toHaveBeenCalledWith({prepared:request,idempotencyKey:`scenario-core:run-1:${scenario.name}`});
    await expect(guard.executePreparedRequest(request)).rejects.toThrow('do not retry');
    await expect(guard.preparePaidRequest(request.request)).rejects.toThrow('do not retry');
  });
  it.each(['transport', 'intent'])('does not reopen execution after %s failure', async (failure) => {
    const {client, onAttempt, guard} = fixture();
    (failure === 'transport' ? client.executePreparedRequest : onAttempt).mockRejectedValue(new Error('lost response'));
    await expect(guard.executePreparedRequest(prepared())).rejects.toThrow('lost response');
    await expect(guard.executePreparedRequest(prepared())).rejects.toThrow('do not retry');
    expect(client.executePreparedRequest).toHaveBeenCalledTimes(failure === 'transport' ? 1 : 0);
  });
  it.each([
    ['price', p => {p.paymentRequirement.amountMinor='1001';p.challengeDetails.accepts[0].amount='1001';}],
    ['asset', p => {p.paymentRequirement.asset='another-token';}],
    ['network', p => {p.paymentRequirement.network='eip155:1';}],
    ['precision', p => {p.paymentRequirement.precision=18;}],
    ['multiple offers', p => {p.challengeDetails.accepts.push({...offer});}],
    ['inconsistent raw offer', p => {p.challengeDetails.accepts[0].amount='2000';}],
    ['not executable', p => {p.nextAction='revise_request';}],
    ['URL', p => {p.request.url='https://other.example/paid';}],
  ])('rejects changed %s before any attempt', async (_label, mutate) => {
    const {client,onAttempt,guard} = fixture();
    const request=prepared(); mutate(request);
    await expect(guard.executePreparedRequest(request)).rejects.toThrow();
    expect(onAttempt).not.toHaveBeenCalled();
    expect(client.executePreparedRequest).not.toHaveBeenCalled();
  });
});

describe('campaign fail-fast evidence', () => {
  it.each(['The budget was exceeded; execution was denied.', 'Execution was denied because it would exceed the remaining budget.'])(
    'accepts equivalent budget-denial wording: %s', (finalText) => {
      const result={preparedId:'p',harnessDisposition:'executed',sdkOutcomeKind:'denied',status:403,paidRequestId:'paid'};
      const transcript={finalText,toolCalls:[
        {name:'prepare_paid_request',result:{kind:'ready',costSummary:'0.1 USDC'}},
        {name:'execute_prepared_request',result},
        {name:'get_execution_result',result:{executionResult:{...result}}},
      ]};
      expect(extractSemanticOutcome(transcript,loadScenarioDefinition('policy-denied-budget-exceeded')).ok).toBe(true);
      transcript.finalText='The request executed successfully.';
      expect(extractSemanticOutcome(transcript,loadScenarioDefinition('policy-denied-budget-exceeded')).ok).toBe(false);
      transcript.finalText='The request was denied.';
      expect(extractSemanticOutcome(transcript,loadScenarioDefinition('policy-denied-budget-exceeded')).ok).toBe(false);
    },
  );
  it.each(['process', 'missing transcript', 'missing receipt', 'mismatched lookup'])('stops before another scenario after %s failure', (failure) => {
    const root=mkdtempSync(resolve(tmpdir(),'402flow-campaign-test-'));
    try {
      mkdirSync(resolve(root,'scripts'),{recursive:true});
      mkdirSync(resolve(root,'examples/openai-harness'),{recursive:true});
      copyFileSync('scripts/run-scenarios.mjs',resolve(root,'scripts/run-scenarios.mjs'));
      for (const name of ['inputs.mjs','first-party-merchant.mjs','transcript-paths.mjs']) {
        copyFileSync(`examples/openai-harness/${name}`,resolve(root,'examples/openai-harness',name));
      }
      cpSync('examples/scenarios',resolve(root,'examples/scenarios'),{recursive:true});
      writeFileSync(resolve(root,'examples/openai-agent-harness.mjs'), `
        import {appendFileSync,writeFileSync} from 'node:fs';
        appendFileSync('calls.txt', process.argv[process.argv.indexOf('--scenario')+1]+'\\n');
        if (${JSON.stringify(failure)} === 'process') process.exit(7);
        if (${JSON.stringify(failure)} === 'missing transcript') process.exit(0);
        const result={preparedId:'p',harnessDisposition:'executed',sdkOutcomeKind:'success',status:200,paidRequestId:'paid'};
        if (${JSON.stringify(failure)} !== 'missing receipt') result.receiptId='receipt';
        const stored={...result};
        if (${JSON.stringify(failure)} === 'mismatched lookup') stored.receiptId='different';
        writeFileSync(process.argv[process.argv.indexOf('--transcript-file')+1],JSON.stringify({toolCalls:[
          {name:'prepare_paid_request',result:{kind:'ready',costSummary:'0.001 USDC'}},
          {name:'execute_prepared_request',result},
          {name:'get_execution_result',result:{executionResult:stored}}
        ]}));
      `);
      const result=spawnSync(process.execPath,['scripts/run-scenarios.mjs','--plan=core'],{cwd:root,encoding:'utf8'});
      expect(result.status).toBe(1);
      expect(readFileSync(resolve(root,'calls.txt'),'utf8').trim().split('\n')).toHaveLength(1);
      expect(readFileSync(resolve(root,'tmp/scenario-summary.txt'),'utf8')).toContain('FAIL');
    } finally {rmSync(root,{recursive:true,force:true});}
  });
});
