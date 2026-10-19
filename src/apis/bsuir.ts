import { fetchJsonApi, textResult } from "./common";

export async function bsuirSchedule(groupNumber: unknown, day: unknown): Promise<object> {
  if (!Number.isInteger(groupNumber) || (groupNumber as number) < 1) throw new Error("group_number must be a positive integer");
  const selected = day === "today" || day === "tomorrow" ? day : "tomorrow";
  const target = new Date(Date.now() + (selected === "tomorrow" ? 86400000 : 0));
  const weekdays = ["Воскресенье", "Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота"];
  const weekday = weekdays[target.getDay()];
  const iso = target.toISOString().slice(0, 10);
  const data = await fetchJsonApi(`https://iis.bsuir.by/api/v1/schedule?studentGroup=${groupNumber}`, {}, 20_000) as { startDate?: string; schedules?: Record<string, Array<Record<string, unknown>>> };
  const start = data.startDate ? data.startDate.split(".").reverse().join("-") : iso;
  const week = Math.floor((Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 604800000) + 1;
  const lessons = (data.schedules?.[weekday] ?? []).filter((lesson) => !Array.isArray(lesson.weekNumber) || (lesson.weekNumber as unknown[]).includes(week)).map((lesson) => ({
    time: `${lesson.startLessonTime ?? ""}-${lesson.endLessonTime ?? ""}`, subject: lesson.subjectFullName ?? lesson.subject ?? "", type: lesson.lessonTypeAbbrev ?? "", room: Array.isArray(lesson.auditories) ? lesson.auditories.join(", ") : "",
  }));
  return textResult(JSON.stringify({ group_number: groupNumber, day: selected, date: iso, weekday, lessons }));
}
