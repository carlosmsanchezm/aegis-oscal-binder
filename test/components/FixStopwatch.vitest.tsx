import React from "react";
import {it,expect,vi} from "vitest";
import {render,screen} from "@testing-library/react";
import {FixStopwatch} from "../../components/binder/FixStopwatch";
it("hides without a batch, measures verification time and preserves human closure wording",()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date("2026-10-30T17:02:03Z"));
 const {rerender}=render(<FixStopwatch progress={null}/>);expect(screen.queryByTestId("fix-stopwatch")).toBeNull();
 rerender(<FixStopwatch progress={{startedAt:"2026-10-30T17:00:00Z",finishedAt:null,total:5,verified:0}}/>);
 expect(screen.getByRole("timer").textContent).toBe("02:03");expect(screen.getByTestId("fix-stopwatch").title).toContain("Human closure remains required");
 rerender(<FixStopwatch progress={{startedAt:"2026-10-30T17:00:00Z",finishedAt:"2026-10-30T17:01:00Z",total:5,verified:5}}/>);
 expect(screen.getByRole("timer").textContent).toBe("01:00");expect(screen.getByText("Review ready")).toBeTruthy();vi.useRealTimers();
});
