import { describe,it,expect,vi } from "vitest";
import { MindGraphMemory,injectMemory,removeProfileMemory } from "./memory.js";
import { withMindGraph } from "./openai.js";
function memory() {
  const m=new MindGraphMemory({spaceUid:"space:a",mode:"profile",capture:false});
  const profile=vi.fn().mockResolvedValueOnce({contract:"memory.v1",scope:{space_uid:"space:a"},include_org_space:false,complete:true,omitted:{item_limit:0,text_budget:0,unsafe_summary:0},unavailable:[],context_text:"old memory"}).mockResolvedValue({contract:"memory.v1",scope:{space_uid:"space:a"},include_org_space:false,complete:true,omitted:{item_limit:0,text_budget:0,unsafe_summary:0},unavailable:[],context_text:"corrected memory"});
  Object.assign(m.client,{contracts:async()=>({contracts:["memory.v1"]}),memory:()=>({profile})});
  return {m,profile};
}
describe("profile lifecycle",()=>{
  it("refreshes Responses input_text profiles and preserves multimodal input",async()=>{
    const {m,profile}=memory();const calls:any[]=[];
    const client={responses:{create:async(body:any)=>{calls.push(body);return {};}}};
    const wrapped=withMindGraph(client,m);
    const system={role:"system",content:"Keep this instruction.\n"};
    const user={role:"user",content:[{type:"input_text",text:"  same question\n"},{type:"input_image",image_url:"data:image/png;base64,AA=="}]};
    await wrapped.responses.create({input:[system,user],instructions:"Keep these too."});
    expect(profile).toHaveBeenCalledTimes(1);
    expect(calls[0].input).toHaveLength(3);
    // A host may carry the injected block back as a Responses text part.
    const carried=calls[0].input.map((message:any,index:number)=>index===1
      ? {...message,content:[{type:"input_text",text:message.content}]} : message);
    await wrapped.responses.create({input:carried,instructions:"Keep these too."});
    expect(profile).toHaveBeenCalledTimes(2);
    expect(calls[1].input).toHaveLength(3);
    expect(JSON.stringify(calls[1].input)).not.toContain("old memory");
    expect(JSON.stringify(calls[1].input)).toContain("corrected memory");
    expect(calls[1].input[0]).toEqual(system);
    expect(calls[1].input.at(-1)).toEqual(user);
    expect(calls[1].instructions).toBe("Keep these too.");
    profile.mockResolvedValueOnce({contract:"memory.v1",scope:{space_uid:"space:a"},include_org_space:false,complete:true,omitted:{item_limit:0,text_budget:0,unsafe_summary:0},unavailable:[],context_text:""});
    await wrapped.responses.create({input:calls[1].input});
    expect(calls[2].input).toEqual([system,user]);
  });
  it("refreshes repeated prompts and replaces carried OpenAI messages",async()=>{
    const {m,profile}=memory();const calls: any[]=[];
    const client={chat:{completions:{create:async(body:any)=>{calls.push(body);return {choices:[]};}}}};
    const wrapped=withMindGraph(client,m);
    await wrapped.chat.completions.create({messages:[{role:"user",content:"same prompt"}]});
    await wrapped.chat.completions.create({messages:calls[0].messages});
    expect(profile).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(calls[1])).not.toContain("old memory");
    expect(JSON.stringify(calls[1])).toContain("corrected memory");
    expect(calls[1].messages).toHaveLength(2);
  });
  it("removes profiles on empty/failure and preserves unrelated system text",async()=>{
    const {m}=memory();const block=(await m.recall("same"))!;
    expect(block).toContain("mindgraph-profile:");
    const clean=removeProfileMemory([{role:"system",content:`Be brief.\n${block}`},{role:"user",content:"same"}]);
    expect(clean[0]?.content).toBe("Be brief.\n");
    expect(clean).toHaveLength(2);
    const next=injectMemory([{role:"user",content:block},{role:"user",content:"same"}],block,"user",text=>({role:"user",content:text}),(msg,text)=>({...msg,content:msg.content+text}),text=>({role:"system",content:text}));
    expect(next).toHaveLength(2);
  });
});

it("preserves unrelated code and multimodal text bytes when recall is disabled",async()=>{
  const calls:any[]=[];const client={chat:{completions:{create:async(body:any)=>{calls.push(body);return {choices:[]};}}}};
  const wrapped=withMindGraph(client,{recall:false,capture:false});
  const messages=[{role:"user",content:'    print("hello")\n'},{role:"user",content:[{type:"text",text:"  code\n"},{type:"image_url",image_url:{url:"https://example.test/image"}}]}];
  await wrapped.chat.completions.create({messages});
  expect(calls[0].messages).toEqual(messages);
});
