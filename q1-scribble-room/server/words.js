// Default word list: things that can be drawn in under a minute.
export const DEFAULT_WORDS = `apple,banana,cherry,grapes,pineapple,strawberry,watermelon,carrot,broccoli,tomato,potato,onion,pizza,burger,sandwich,
hot dog,ice cream,cake,cookie,donut,popcorn,pancake,sushi,noodles,egg,cheese,bread,chocolate,candy,lollipop,coffee,tea,milk,
dog,cat,horse,cow,pig,sheep,goat,chicken,duck,rabbit,mouse,elephant,giraffe,lion,tiger,bear,monkey,zebra,kangaroo,penguin,
dolphin,whale,shark,octopus,crab,fish,turtle,frog,snake,spider,butterfly,bee,ant,snail,owl,eagle,parrot,flamingo,peacock,
house,castle,bridge,tower,tent,igloo,lighthouse,windmill,barn,church,school,hospital,skyscraper,pyramid,fence,door,window,stairs,
car,bus,train,airplane,helicopter,rocket,boat,ship,submarine,bicycle,motorcycle,scooter,tractor,truck,ambulance,taxi,balloon,
sun,moon,star,cloud,rainbow,lightning,snowflake,volcano,mountain,river,waterfall,island,desert,forest,beach,wave,tornado,
tree,flower,rose,sunflower,cactus,mushroom,leaf,grass,bush,palm tree,pumpkin,
chair,table,bed,sofa,lamp,clock,mirror,television,computer,phone,keyboard,camera,headphones,microphone,guitar,piano,drum,violin,
book,pencil,pen,scissors,ruler,backpack,umbrella,glasses,hat,shoe,sock,shirt,jacket,dress,crown,ring,necklace,watch,
key,lock,bell,candle,flashlight,battery,magnet,compass,map,flag,anchor,sword,shield,arrow,bomb,hammer,saw,ladder,
bucket,broom,shovel,toothbrush,soap,towel,bathtub,toilet,sink,fridge,oven,spoon,fork,knife,plate,cup,bottle,teapot,
football,basketball,tennis,golf,bowling,skateboard,surfboard,trophy,medal,dice,chess,puzzle,kite,yo-yo,
ghost,robot,alien,dragon,unicorn,pirate,wizard,mermaid,snowman,scarecrow,vampire,angel,
heart,smile,eye,nose,ear,hand,foot,tooth,brain,skull,bone,
fire,water,ice,smoke,bubble,shadow,rain,snow,wind,
bathroom,garden,playground,circus,zoo,farm,airport,museum,library,restaurant,
sleeping,running,swimming,dancing,fishing,painting,cooking,reading,laughing,crying`
  .split(/[,\n]/)
  .map((w) => w.trim())
  .filter(Boolean);
