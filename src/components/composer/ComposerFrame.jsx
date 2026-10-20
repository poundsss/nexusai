import React, { useState } from "react";
import ChatColumn from "@/components/composer/ChatColumn";
import GrowComposerOutline from "@/components/composer/GrowComposerOutline";

// Match Home's initial chat height and inline textarea baseline gap.
// The project strip adds its own height above the chat, never reducing it.
// Both inputs can grow to six actual text lines before scrolling.
export default function ComposerFrame({ children, projectBar = null, className = "", ...props }) {
  const [container, setContainer] = useState(null);
  const card = (
    <div
      {...(projectBar ? {} : props)}
      className={`relative oled-border flex w-full flex-col rounded-3xl backdrop-blur transition-colors [&>textarea]:block [&>textarea]:shrink-0 [&>textarea]:overflow-y-auto [&>textarea]:mb-1 [&>textarea]:max-h-[calc(6*1.625*17px+1.25rem)] [&>textarea]:min-h-[calc(3*1.625*17px+1.25rem)] ${projectBar ? "grow-composer-body" : ""} ${className}`}
    >
      {children}
    </div>
  );
  return (
    <ChatColumn>
      {projectBar ? (
        <div {...props} ref={setContainer} className="grow-project-composer relative w-full">
          <GrowComposerOutline container={container} />
          <div className="relative shrink-0">{projectBar}</div>
          {card}
        </div>
      ) : card}
    </ChatColumn>
  );
}