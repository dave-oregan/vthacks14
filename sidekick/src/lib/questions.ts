export interface Question {
  index: number;
  prompt: string;
  options: string[];
}

export const QUESTIONS: Question[] = [
  {
    index: 0,
    prompt: "What do you lose or forget the most?",
    options: [
      "My keys",
      "My phone / AirPods",
      "Assignments / deadlines",
      "Names and conversations",
      "Where I parked",
      "Honestly... everything",
    ],
  },
  {
    index: 1,
    prompt: "When would you want your AI sidekick to intervene?",
    options: [
      "When I'm forgetting something",
      "When I might be unsafe",
      "When I'm overwhelmed",
      "When I'm meeting people",
      "Before I make a dumb decision",
      "Basically all the time",
    ],
  },
  {
    index: 2,
    prompt: "What would your glasses probably see you doing the most?",
    options: [
      "Studying",
      "Coding / building",
      "At the gym",
      "Partying / going out",
      "Wandering around campus",
      "Talking to people",
      "Somehow doing five things at once",
    ],
  },
];
