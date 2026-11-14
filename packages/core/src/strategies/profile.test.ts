import { recallByQuery } from "./query.js";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { recallProfile } from "./profile.js";
import { resolveOptions } from "../client.js";
function fixture() {
  const profile=vi.fn(async (options: { project_uid?: string; include_org_space: boolean }) => ({
    contract:"memory.v1",scope:{space_uid:"space:a"},project_uid:options.project_uid,include_org_space:options.include_org_space,
    context_text:"## memories\n- staging cluster [n1]",complete:false,
    omitted:{item_limit:2,text_budget:0,unsafe_summary:0},unavailable:[],
  }));
  const memory=vi.fn(() => ({profile}));
  const contracts=vi.fn(async () => ({contracts:["memory.v1"]}));
  return {client:{memory,contracts} as never,memory,profile,contracts};
}
describe("explicit profile recall",()=>{
  it("preserves Space and Project; exposes incompleteness",async()=>{
    const f=fixture(), onError=vi.fn();
    const out=await recallProfile(f.client,resolveOptions({spaceUid:"space:a",projectUid:"p1",onError}));
    expect(f.memory).toHaveBeenCalledWith({space_uid:"space:a"});
    expect(f.profile).toHaveBeenCalledWith({project_uid:"p1",include_org_space:false,format:"text",max_tokens:4000});
    expect(out?.omitted.item_limit).toBe(2);expect(onError).toHaveBeenCalledWith(expect.any(Error),"profile_incomplete");
    const other=await recallProfile(f.client,resolveOptions({spaceUid:"space:a",projectUid:"p2"}));
    expect(other?.id).not.toBe(out?.id);
  });
  it("does no network work without explicit Space",async()=>{
    const f=fixture();expect(await recallProfile(f.client,resolveOptions())).toBeNull();expect(f.contracts).not.toHaveBeenCalled();
  });
  it("never calls profile when capability is absent",async()=>{
    const f=fixture();f.contracts.mockResolvedValue({contracts:[]});
    expect(await recallProfile(f.client,resolveOptions({spaceUid:"space:a"}))).toBeNull();expect(f.memory).not.toHaveBeenCalled();
  });
  it("fails open on scope mismatch without widening or fallback",async()=>{
    const f=fixture();const onError=vi.fn();
    expect(await recallProfile(f.client,resolveOptions({spaceUid:"space:other",onError}))).toBeNull();
    expect(f.profile).toHaveBeenCalledTimes(1);expect(onError).toHaveBeenCalledWith(expect.any(Error),"profile");
  });
});

it("consumes the canonical server profile wire fixture",async()=>{
  const fixtures=JSON.parse(readFileSync(new URL("../../../../fixtures/memory-v1.json",import.meta.url),"utf8"));
  const row=fixtures.cases.find((f:{name:string})=>f.name==="profile");
  const client={contracts:async()=>({contracts:["memory.v1"]}),memory:vi.fn(()=>({profile:vi.fn(async()=>row.response)}))};
  const result=await recallProfile(client as never,resolveOptions({spaceUid:row.request.scope.space_uid}));
  expect(result?.text).toBe(row.response.context_text);
  expect(result?.complete).toBe(row.response.complete);
  expect(result?.omitted).toEqual(row.response.omitted);
});

it("uses the scoped context door and canonical context fixture without widening",async()=>{
  const fixtures=JSON.parse(readFileSync(new URL("../../../../fixtures/memory-v1.json",import.meta.url),"utf8"));
  const row=fixtures.cases.find((f:{name:string})=>f.name==="context");
  const context=vi.fn(async(_options:object)=>row.response);
  const memory=vi.fn(()=>({context}));
  const retrieveContext=vi.fn();
  const result=await recallByQuery({memory,retrieveContext} as never,resolveOptions({spaceUid:row.request.scope.space_uid}),"staging");
  expect(memory).toHaveBeenCalledWith(row.request.scope);
  expect(context).toHaveBeenCalledWith(expect.objectContaining({query:"staging",include_org_space:false}));
  expect(context.mock.calls[0]?.[0]).not.toHaveProperty("include_graph");
  expect(retrieveContext).not.toHaveBeenCalled();
  expect(result?.text).toBe(row.response.context_text);
  context.mockRejectedValueOnce(new Error("scope echo mismatch"));
  expect(await recallByQuery({memory,retrieveContext} as never,resolveOptions({spaceUid:row.request.scope.space_uid,projectUid:"project:alpha",includeOrgSpace:true}),"staging")).toBeNull();
  expect(context).toHaveBeenLastCalledWith(expect.objectContaining({project_uid:"project:alpha",include_org_space:true}));
  expect(retrieveContext).not.toHaveBeenCalled();
});
