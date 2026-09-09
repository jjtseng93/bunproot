import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { destination, parseClone } from "./index.js";

test("clone arguments use Git's repository then directory order", () => {
  expect(destination("https://example.com/owner/project.git")).toBe("project");
  expect(destination("git@example.com:owner/project.git")).toBe("project");
  expect(parseClone(["https://example.com/a.git"])).toMatchObject({
    url:"https://example.com/a.git", dir:resolve("a"), remote:"origin",
  });
  expect(parseClone(["URL","checkout"])).toMatchObject({ url:"URL",dir:resolve("checkout") });
});

test("the first clone release accepts common Git clone options", () => {
  expect(parseClone(["--depth=1","-b","main","--single-branch","--no-tags","URL","dst"]))
    .toMatchObject({ depth:1,ref:"main",singleBranch:true,noTags:true,url:"URL",dir:resolve("dst") });
  expect(parseClone(["-q","-n","-o","upstream","--","-repo","dst"]))
    .toMatchObject({ quiet:true,noCheckout:true,remote:"upstream",url:"-repo",dir:resolve("dst") });
  expect(()=>parseClone(["--depth","0","URL"])).toThrow("positive integer");
  expect(()=>parseClone(["--mirror","URL"])).toThrow("unknown option");
});
