import type { RunChatController } from "./use-run-chat";
import { formatTime } from "./utils";

interface TodoDesktopWindowProps {
  runChat: RunChatController;
}

export function TodoDesktopWindow({ runChat }: TodoDesktopWindowProps) {
  return (
    <section className="panel window-single-column">
      <h3>TodoList</h3>
      <p className="muted">当前 run: {runChat.activeRunId ?? "-"}</p>
      <div className="todo-grid">
        {(Object.keys(runChat.groupedTodos) as Array<
          keyof typeof runChat.groupedTodos
        >).map((status) => (
          <div key={status} className="todo-column">
            <h4>
              {status} <span>{runChat.groupedTodos[status].length}</span>
            </h4>
            {runChat.groupedTodos[status].length === 0 ? (
              <p className="muted">空</p>
            ) : (
              runChat.groupedTodos[status].map((item) => (
                <div key={`${item.runId}-${item.todoId}`} className="todo-card">
                  <div className="todo-order">#{item.order}</div>
                  <div className="todo-content">{item.content}</div>
                </div>
              ))
            )}
          </div>
        ))}
      </div>

      <div className="todo-events">
        <h4>Todo Timeline</h4>
        {runChat.todoEvents.length === 0 ? (
          <p className="muted">暂无事件</p>
        ) : (
          <ul>
            {runChat.todoEvents.slice(-25).map((event) => (
              <li key={event.eventId}>
                <time>{formatTime(event.eventTs)}</time>
                <span>
                  [{event.status}] #{event.order} {event.content}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
